import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  bindResource,
  createAwsClientConfig,
  createLambdaHandlers,
} from "@voke/aws";
import {
  dynamodbTable,
  s3Bucket,
  secret,
  snsTopic,
  sqsQueue,
  synthesizeCloudFormation,
  ssmParameter,
} from "@voke/aws/cloudformation";
import type {
  APIGatewayProxyResult,
  LambdaContext,
  LambdaEvent,
} from "hono/aws-lambda";

import { voke } from "../src/app";
import type { Middleware } from "../src/app";
import { createApiProject, runCli } from "../src/cli";
import { defineConfig, getConfig, loadVokeConfig } from "../src/config";
import { awsContext } from "../src/context";
import { VokeConfigError } from "../src/errors";
import { fn, createFunctions, http } from "../src/invoke";
import type { StandardSchemaV1 } from "../src/invoke";
import { route } from "../src/route-builder";
import { setEnv } from "./support/env";
import { tempPath } from "./support/temp";

const lambdaEvent = (overrides: Record<string, unknown>): LambdaEvent => {
  const requestContext = {
    accountId: "local",
    apiId: "local",
    authentication: null,
    authorizer: {},
    domainName: "localhost",
    domainPrefix: "localhost",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "bun:test",
    },
    requestId: "req_local",
    routeKey: "$default",
    stage: "$default",
    time: "01/Jan/2026:00:00:00 +0000",
    timeEpoch: 1_767_225_600_000,
  };
  const { requestContext: overrideRequestContext, ...rest } = overrides as {
    requestContext?: { http?: Record<string, unknown> };
  } & Record<string, unknown>;

  return {
    body: null,
    headers: {
      host: "localhost",
    },
    isBase64Encoded: false,
    rawPath: "/",
    rawQueryString: "",
    requestContext: {
      ...requestContext,
      ...overrideRequestContext,
      http: {
        ...requestContext.http,
        ...overrideRequestContext?.http,
      },
    },
    routeKey: "$default",
    version: "2.0",
    ...rest,
  } as LambdaEvent;
};

const passthroughSchema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

test("activates local Function Registry invocation through voke()", async () => {
  const functions = createFunctions({
    greet: fn({
      handler: (payload) => ({ message: `hello ${payload.name}` }),
      input: passthroughSchema<{ name: string }>(),
      output: passthroughSchema<{ message: string }>(),
    }),
  });

  await expect(functions.invoke("greet", { name: "before" })).rejects.toThrow(
    VokeConfigError
  );
  await expect(functions.invoke("greet", { name: "before" })).rejects.toThrow(
    "Local Function invocation requires Gateway activation"
  );

  const gateway = voke(functions, { config: { name: "greeting-api" } });

  expect(gateway.fetch).toBeFunction();
  await expect(functions.invoke("greet", { name: "Victor" })).resolves.toEqual({
    message: "hello Victor",
  });
});

test("rejects a Function Registry passed through config", () => {
  const functions = createFunctions({
    ping: fn({
      handler: () => ({ ok: true }),
      output: passthroughSchema<{ ok: boolean }>(),
    }),
  });
  const config = { functions, name: "config-functions-api" } as never;

  expect(() => voke(functions, { config })).toThrow(VokeConfigError);
  expect(() => voke(functions, { config })).toThrow(
    "functions: Functions are declared in the project entrypoint, not in voke.config.ts"
  );
});

// The Lambda handler `voke build` generates for the Function keyed "http".
const lambdaHttpHandler = (gateway: {
  app: unknown;
  config: unknown;
  functions: unknown;
}) =>
  createLambdaHandlers({ default: gateway }).http as (
    event: LambdaEvent,
    context?: LambdaContext
  ) => Promise<APIGatewayProxyResult>;

test("handles a Lambda HTTP API v2 GET request", async () => {
  const gateway = voke(
    createFunctions({
      http: http({
        routes: [
          route.get("/hello/:name", {
            handler: (request) => ({
              greeting: new URL(request.raw.url).searchParams.get("greeting"),
              name: request.params.name,
            }),
          }),
        ],
      }),
    }),
    { config: { name: "hello-api" } }
  );
  const response = await lambdaHttpHandler(gateway)(
    lambdaEvent({
      headers: {
        host: "api.example.com",
        "x-forwarded-proto": "https",
      },
      rawPath: "/hello/victor",
      rawQueryString: "greeting=hi",
      requestContext: {
        http: {
          method: "GET",
          path: "/hello/victor",
        },
      },
    })
  );

  expect(response.statusCode).toBe(200);
  expect(response.isBase64Encoded).toBe(false);
  expect(response.headers?.["content-type"]).toContain("application/json");
  expect(JSON.parse(response.body)).toEqual({
    data: {
      greeting: "hi",
      name: "victor",
    },
  });
});

test("handles a Lambda HTTP API v2 POST body", async () => {
  const gateway = voke(
    createFunctions({
      http: http({
        routes: [
          route.post("/echo", {
            handler: async (request) => (await request.raw.json()) as unknown,
          }),
        ],
      }),
    }),
    { config: { name: "echo-api" } }
  );
  const response = await lambdaHttpHandler(gateway)(
    lambdaEvent({
      body: JSON.stringify({ ok: true }),
      headers: {
        "content-type": "application/json",
        host: "localhost",
      },
      rawPath: "/echo",
      requestContext: {
        http: {
          method: "POST",
          path: "/echo",
        },
      },
    })
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ data: { ok: true } });
});

const contextHelpers: Middleware = async (c, next) => {
  await next();
  c.header("x-service", getConfig(c).name);
  c.header("x-request-id", awsContext(c)?.awsRequestId ?? "none");
};

test("exposes config and Lambda context helpers to Gateway middleware", async () => {
  const gateway = voke(
    createFunctions({
      http: http({
        routes: [
          route.get("/users/:id", {
            handler: (request) => ({ id: request.params.id }),
          }),
        ],
      }),
    }),
    {
      config: { name: "users-api", region: "sa-east-1", stage: "test" },
      middleware: [contextHelpers],
    }
  );
  const response = await lambdaHttpHandler(gateway)(
    lambdaEvent({
      rawPath: "/users/usr_1",
      requestContext: {
        http: {
          method: "GET",
          path: "/users/usr_1",
        },
      },
    }),
    {
      awsRequestId: "req_123",
    } as LambdaContext
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ data: { id: "usr_1" } });
  expect(response.headers?.["x-service"]).toBe("users-api");
  expect(response.headers?.["x-request-id"]).toBe("req_123");
});

test("returns default JSON errors for missing routes", async () => {
  const gateway = voke(
    createFunctions({
      http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
    }),
    { config: { name: "missing-route-api" } }
  );
  const response = await lambdaHttpHandler(gateway)(
    lambdaEvent({
      rawPath: "/missing",
      requestContext: {
        http: {
          method: "GET",
          path: "/missing",
        },
      },
    })
  );

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body)).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  });
});

test("creates a starter API project", async () => {
  const directory = tempPath(`voke-created-api-${crypto.randomUUID()}`);

  await createApiProject({
    directory,
    name: "created-api",
  });

  const packageJson = await Bun.file(`${directory}/package.json`).json();
  const index = await Bun.file(`${directory}/src/index.ts`).text();
  const healthRoute = await Bun.file(
    `${directory}/src/routes/health.ts`
  ).text();
  const config = await Bun.file(`${directory}/voke.config.ts`).text();
  const testFile = await Bun.file(`${directory}/test/api.test.ts`).text();

  expect(packageJson.name).toBe("@voke/created-api");
  expect(packageJson.dependencies["@voke/aws"]).toBe("^0.0.0");
  expect(packageJson.dependencies.voke).toBe("^0.0.0");
  expect(packageJson.scripts.build).toBe("voke build");
  expect(packageJson.scripts.dev).toBe("voke dev");
  expect(packageJson.scripts.synth).toBe("voke synth");
  expect(packageJson.scripts.test).toBe("bun test");
  expect(packageJson.scripts.typecheck).toBe(
    "bunx tsgo --project tsconfig.json --noEmit"
  );
  expect(config).toContain('name: "created-api"');
  expect(config).toContain('entrypoint: "./src/index.ts"');
  expect(config).toContain('out: "./dist/cloudformation.json"');
  expect(config).toContain('import { aws } from "@voke/aws";');
  expect(config).toContain("provider: aws()");
  expect(index).toContain("createFunctions");
  expect(index).toContain("http");
  expect(index).toContain("voke");
  expect(index).toContain("voke.config");
  expect(index).toContain("routes: [healthRoute]");
  expect(healthRoute).toContain("healthRoute");
  expect(testFile).toContain("responds to health checks");
});

test("generated starter test suite passes with local package links", async () => {
  const directory = tempPath(`voke-created-api-smoke-${crypto.randomUUID()}`);

  await createApiProject({
    directory,
    name: "created-api-smoke",
  });
  await Bun.$`mkdir -p ${directory}/node_modules`;
  await Bun.$`mkdir -p ${directory}/node_modules/@voke`;
  await Bun.$`ln -s ${`${import.meta.dir}/..`} ${`${directory}/node_modules/voke`}`;
  await Bun.$`ln -s ${`${import.meta.dir}/../../aws`} ${`${directory}/node_modules/@voke/aws`}`;
  await Bun.$`ln -s ${`${import.meta.dir}/../../testing`} ${`${directory}/node_modules/@voke/testing`}`;
  await Bun.$`ln -s ${`${import.meta.dir}/../node_modules/hono`} ${`${directory}/node_modules/hono`}`;

  const process = Bun.spawn(["bun", "test"], {
    cwd: directory,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await process.exited;
  const stderr = await new Response(process.stderr).text();
  const stdout = await new Response(process.stdout).text();

  const output = `${stdout}\n${stderr}`;

  // Bun does not print passing test names in non-interactive output, so assert on the
  // summary: exactly the one generated test ran and passed.
  expect(output).toMatch(/^\s*1 pass$/mu);
  expect(output).toMatch(/^\s*0 fail$/mu);
  expect(exitCode).toBe(0);
});

test("normalizes project and CloudFormation settings through defineConfig", () => {
  const config = defineConfig({
    build: {
      outdir: "./build",
    },
    cloudFormation: {
      out: "./build/stack.json",
    },
    entrypoint: "./src/api.ts",
    environment: {
      LOG_LEVEL: "debug",
    },
    name: "orders-api",
    region: "sa-east-1",
    resources: {
      ordersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "prod",
  });

  expect(config).toEqual({
    api: {
      name: "orders-api",
    },
    build: {
      entrypoints: ["./src/api.ts"],
      external: ["@aws-sdk/*"],
      outdir: "./build",
    },
    cloudFormation: {
      out: "./build/stack.json",
    },
    dev: {
      entrypoint: "./src/api.ts",
      environment: {},
    },
    entrypoint: "./src/api.ts",
    environment: {
      LOG_LEVEL: "debug",
    },
    local: {
      provider: expect.objectContaining({
        name: "floci",
      }),
      providerOptional: true,
    },
    name: "orders-api",
    region: "sa-east-1",
    resources: {
      ordersTable: dynamodbTable({ partitionKey: "id" }),
    },
    runtime: {
      lambda: "nodejs22.x",
    },
    stage: "prod",
  });
});

test("only supports nodejs22 and nodejs24 Lambda runtimes in defineConfig", () => {
  expect(
    defineConfig({
      name: "runtime-api",
      runtime: {
        lambda: "nodejs24.x",
      },
    }).runtime.lambda
  ).toBe("nodejs24.x");
  expect(() =>
    defineConfig({
      name: "runtime-api",
      runtime: {
        lambda: "nodejs20.x",
      },
    } as unknown as Parameters<typeof defineConfig>[0])
  ).toThrow(
    'Invalid Voke config at runtime.lambda: expected one of "nodejs22.x", "nodejs24.x"; received "nodejs20.x"'
  );
  expect(() =>
    defineConfig({
      name: "runtime-api",
      runtime: {
        lambda: "python3.12",
      },
    } as unknown as Parameters<typeof defineConfig>[0])
  ).toThrow(
    'Invalid Voke config at runtime.lambda: expected one of "nodejs22.x", "nodejs24.x"; received "python3.12"'
  );
});

test("exposes AWS resource helpers from @voke/aws", () => {
  const template = synthesizeCloudFormation(
    defineConfig({
      name: "aws-subpath-api",
      resources: {
        jobsQueue: sqsQueue(),
        notificationsTopic: snsTopic(),
        ordersTable: dynamodbTable({ partitionKey: "id" }),
        publicConfig: ssmParameter({ value: "enabled" }),
        signingSecret: secret(),
        uploadsBucket: s3Bucket(),
      },
    })
  );

  expect(template.Resources.OrdersTable?.Type).toBe("AWS::DynamoDB::Table");
  expect(template.Resources.JobsQueue?.Type).toBe("AWS::SQS::Queue");
  expect(template.Resources.UploadsBucket?.Type).toBe("AWS::S3::Bucket");
  expect(template.Resources.NotificationsTopic?.Type).toBe("AWS::SNS::Topic");
  expect(template.Resources.SigningSecret?.Type).toBe(
    "AWS::SecretsManager::Secret"
  );
  expect(template.Resources.PublicConfig?.Type).toBe("AWS::SSM::Parameter");
});

test("loads voke.config.ts default export", async () => {
  const directory = tempPath(`voke-config-${crypto.randomUUID()}`);
  const configPath = `${directory}/voke.config.ts`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";
import { sqsQueue } from "${import.meta.dir}/../../aws/src/cloudformation.ts";

export default defineConfig({
  name: "configured-api",
  stage: "test",
  region: "sa-east-1",
  entrypoint: "./src/service.ts",
  environment: {
    LOG_LEVEL: "info",
  },
  resources: {
    jobsQueue: sqsQueue(),
  },
  cloudFormation: {
    out: "./build/template.json",
  },
});
`
  );

  const config = await loadVokeConfig({ path: configPath });

  expect(config.name).toBe("configured-api");
  expect(config.stage).toBe("test");
  expect(config.region).toBe("sa-east-1");
  expect(config.entrypoint).toBe("./src/service.ts");
  expect(config.cloudFormation.out).toBe("./build/template.json");
  expect(config.environment).toEqual({ LOG_LEVEL: "info" });
  expect(Object.keys(config.resources)).toEqual(["jobsQueue"]);
});

// synth and build import the project entrypoint to discover its Functions.
const writeHttpEntrypoint = async (path: string): Promise<void> => {
  await Bun.write(
    path,
    `import { createFunctions, http, route } from "${import.meta.dir}/../src/index.ts";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );
};

const withPwd = async <TResult>(
  directory: string,
  run: () => Promise<TResult>
): Promise<TResult> => {
  const previous = process.env.PWD;
  process.env.PWD = directory;

  try {
    return await run();
  } finally {
    process.env.PWD = previous;
  }
};

test("synth CLI reads voke.config.ts and writes the configured template path", async () => {
  const directory = tempPath(`voke-synth-config-${crypto.randomUUID()}`);
  const out = `${directory}/build/template.json`;
  const configPath = `${directory}/voke.config.ts`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";
import { sqsQueue } from "${import.meta.dir}/../../aws/src/cloudformation.ts";
import { aws } from "${import.meta.dir}/../../aws/src/index.ts";

export default defineConfig({
  name: "configured-synth",
  provider: aws(),
  stage: "qa",
  region: "sa-east-1",
  entrypoint: "./src/service.ts",
  environment: {
    LOG_LEVEL: "info",
  },
  resources: {
    jobsQueue: sqsQueue(),
  },
  cloudFormation: {
    out: "${out}",
  },
});
`
  );

  await writeHttpEntrypoint(`${directory}/src/service.ts`);
  await withPwd(directory, () => runCli(["synth", "--config", configPath]));

  const template = await Bun.file(out).json();

  expect(template.Description).toBe("Voke stack for configured-synth (qa)");
  expect(template.Resources.Function.Metadata.VokeEntrypoint).toBe(
    "./src/service.ts"
  );
  expect(
    template.Resources.Function.Properties.Environment.Variables.LOG_LEVEL
  ).toBe("info");
  expect(
    template.Resources.Function.Properties.Environment.Variables
      .VOKE_RESOURCE_JOBS_QUEUE_URL
  ).toEqual({
    Ref: "JobsQueue",
  });
});

test("runs create and build through the CLI parser", async () => {
  const directory = tempPath(`voke-cli-api-${crypto.randomUUID()}`);
  const buildDirectory = tempPath(`voke-cli-build-${crypto.randomUUID()}`);
  const entrypoint = `${directory}/src/smoke.ts`;

  const configPath = `${directory}/build.config.ts`;

  await runCli(["create", "api", "cli-api", directory]);
  await writeHttpEntrypoint(entrypoint);
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";
import { aws } from "${import.meta.dir}/../../aws/src/index.ts";

export default defineConfig({ name: "cli-api", provider: aws() });
`
  );

  try {
    await runCli(["build", "--config", configPath, entrypoint, buildDirectory]);

    expect(await Bun.file(`${directory}/src/routes/health.ts`).exists()).toBe(
      true
    );
    expect(await Bun.file(`${buildDirectory}/index.js`).exists()).toBe(true);
    expect(
      await Bun.file(`${buildDirectory}/voke-manifest.json`).json()
    ).toMatchObject({ functions: { http: { handler: "index.http" } } });
  } finally {
    // The generated entry lives under the working directory, as in a real project.
    await rm(".voke", { force: true, recursive: true });
  }
});

// The Function keyed "http" owns the bare Function/FunctionRole/Permission logical ids.
const healthFunctions = () =>
  createFunctions({
    http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
  });

test("synthesizes a CloudFormation template with API, Lambda, IAM, resources, bindings, and outputs", () => {
  const template = synthesizeCloudFormation({
    ...defineConfig({
      entrypoint: "./src/index.ts",
      environment: {
        LOG_LEVEL: "info",
      },
      name: "orders-api",
      region: "sa-east-1",
      resources: {
        eventsQueue: sqsQueue(),
        orderCreatedTopic: snsTopic(),
        ordersTable: dynamodbTable({ partitionKey: "pk", sortKey: "sk" }),
        publicConfig: ssmParameter({ value: "enabled" }),
        signingSecret: secret(),
        uploadsBucket: s3Bucket(),
      },
      stage: "prod",
    }),
    functions: healthFunctions(),
  });
  const resources = template.Resources;
  const outputs = template.Outputs;
  const apiResource = resources.Api;
  const functionResource = resources.Function;
  const functionRoleResource = resources.FunctionRole as unknown as {
    Properties: {
      Policies: { PolicyDocument: { Statement: unknown[] } }[];
    };
  };
  const apiUrlOutput = outputs.ApiUrl;
  const ordersTableOutput = outputs.OrdersTableName;

  if (
    apiResource === undefined ||
    functionResource === undefined ||
    apiUrlOutput === undefined ||
    ordersTableOutput === undefined
  ) {
    throw new Error("Expected synthesized stack resources and outputs");
  }

  const functionProperties = functionResource.Properties as {
    Environment: { Variables: Record<string, unknown> };
  };

  expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
  expect(apiResource.Type).toBe("AWS::ApiGatewayV2::Api");
  expect(functionResource.Type).toBe("AWS::Lambda::Function");
  expect(functionProperties.Environment.Variables).toEqual({
    LOG_LEVEL: "info",
    VOKE_RESOURCE_EVENTS_QUEUE_URL: { Ref: "EventsQueue" },
    VOKE_RESOURCE_ORDERS_TABLE_NAME: { Ref: "OrdersTable" },
    VOKE_RESOURCE_ORDER_CREATED_TOPIC_ARN: { Ref: "OrderCreatedTopic" },
    VOKE_RESOURCE_PUBLIC_CONFIG_NAME: { Ref: "PublicConfig" },
    VOKE_RESOURCE_SIGNING_SECRET_ID: { "Fn::GetAtt": ["SigningSecret", "Id"] },
    VOKE_RESOURCE_UPLOADS_BUCKET_NAME: { Ref: "UploadsBucket" },
  });
  expect(
    functionRoleResource.Properties.Policies[0]?.PolicyDocument.Statement
  ).toContainEqual({
    Action: [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ],
    Effect: "Allow",
    Resource: { "Fn::GetAtt": ["OrdersTable", "Arn"] },
  });
  expect(apiUrlOutput.Value).toEqual({
    "Fn::Sub": `https://\${Api}.execute-api.\${AWS::Region}.amazonaws.com`,
  });
  expect(ordersTableOutput.Value).toEqual({ Ref: "OrdersTable" });
});

test("matches the CloudFormation snapshot for a minimal API stack", async () => {
  const template = synthesizeCloudFormation({
    entrypoint: "./src/index.ts",
    functions: healthFunctions(),
    name: "snapshot-api",
    region: "us-east-1",
    stage: "test",
  });
  const snapshot = await Bun.file(
    `${import.meta.dir}/fixtures/minimal-cloudformation.json`
  ).json();

  expect(template).toEqual(snapshot);
});

test("creates typed AWS resource bindings and client config from environment", () => {
  const table = bindResource("ordersTable", "name");
  const queue = bindResource("eventsQueue", "url");
  const previous = {
    endpoint: Bun.env.VOKE_AWS_ENDPOINT_URL,
    queue: Bun.env.VOKE_RESOURCE_EVENTS_QUEUE_URL,
    region: Bun.env.AWS_REGION,
    table: Bun.env.VOKE_RESOURCE_ORDERS_TABLE_NAME,
  };

  Bun.env.VOKE_RESOURCE_ORDERS_TABLE_NAME = "orders-prod";
  Bun.env.VOKE_RESOURCE_EVENTS_QUEUE_URL = "https://sqs.local/queue";
  Bun.env.AWS_REGION = "sa-east-1";
  Bun.env.VOKE_AWS_ENDPOINT_URL = "http://localhost:4566";

  expect(table.envName).toBe("VOKE_RESOURCE_ORDERS_TABLE_NAME");
  expect(table.value()).toBe("orders-prod");
  expect(queue.value()).toBe("https://sqs.local/queue");
  expect(createAwsClientConfig()).toEqual({
    endpoint: "http://localhost:4566",
    region: "sa-east-1",
  });

  setEnv("VOKE_RESOURCE_ORDERS_TABLE_NAME", previous.table);
  setEnv("VOKE_RESOURCE_EVENTS_QUEUE_URL", previous.queue);
  setEnv("AWS_REGION", previous.region);
  setEnv("VOKE_AWS_ENDPOINT_URL", previous.endpoint);
});

test("runs synth through the CLI parser with config overrides", async () => {
  const directory = tempPath(`voke-cfn-${crypto.randomUUID()}`);
  const templatePath = `${directory}/template.json`;
  const configPath = `${directory}/voke.config.ts`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";
import { aws } from "${import.meta.dir}/../../aws/src/index.ts";

export default defineConfig({
  entrypoint: "${directory}/src/index.ts",
  name: "orders-api",
  provider: aws(),
  stage: "prod",
});
`
  );

  await writeHttpEntrypoint(`${directory}/src/index.ts`);
  await runCli([
    "synth",
    "--config",
    configPath,
    "--name",
    "orders-api",
    "--stage",
    "prod",
    "--out",
    templatePath,
  ]);
  const template = await Bun.file(templatePath).json();

  expect(template.Resources.Function.Type).toBe("AWS::Lambda::Function");
});
