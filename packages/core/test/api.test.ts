import { expect, test } from "bun:test";

import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";

import { api } from "../src/api";
import { createApiApp, createGateway, routeModule } from "../src/app";
import {
  bindResource,
  createAwsClientConfig,
  dynamodbTable,
  s3Bucket,
  secret,
  snsTopic,
  sqsQueue,
  ssmParameter,
} from "../src/aws";
import { handleAwsLambdaRequest } from "../src/aws-lambda";
import { createApiProject, runCli } from "../src/cli";
import { synthesizeCloudFormation } from "../src/cloudformation";
import { defineConfig, getConfig, loadVokeConfig } from "../src/config";
import { awsContext } from "../src/context";
import type { VokeEnv } from "../src/context";
import { VokeConfigError } from "../src/errors";
import { defineFunction, defineFunctions } from "../src/invoke";
import type { StandardSchemaV1 } from "../src/invoke";
import { ok as json } from "../src/response";

const restoreEnv = (name: string, value?: string): void => {
  Bun.env[name] = value;
};

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

test("wraps a Hono app with a default name and handler", () => {
  const app = new Hono();
  const vokeApi = api(app);

  expect(vokeApi.name).toBe("api");
  expect(vokeApi.config).toEqual({
    api: {
      function: "api",
      name: "api",
      protocol: "http",
      routes: ["$default"],
    },
    build: {
      entrypoints: ["./src/index.ts"],
      outdir: "./dist",
      target: "bun",
    },
    cloudFormation: {
      environment: {},
      handler: "index.handler",
      out: "./dist/cloudformation.json",
      resources: {},
    },
    dev: {
      entrypoint: "./src/index.ts",
      environment: {},
    },
    entrypoint: "./src/index.ts",
    functions: {},
    local: {
      provider: expect.objectContaining({
        name: "floci",
      }),
      providerOptional: true,
    },
    name: "api",
    region: "us-east-1",
    runtime: {
      lambda: "nodejs22.x",
    },
    stage: "local",
  });
  expect(vokeApi.app).toBe(app);
  expect(vokeApi.fetch).toBeFunction();
  expect(vokeApi.handler).toBeFunction();
});

test("uses createApiApp config metadata when wrapping a Hono app", () => {
  const app = createApiApp({
    config: {
      api: {
        name: "orders-http",
        routes: ["GET /orders", "POST /orders"],
      },
      cloudFormation: {
        environment: {
          LOG_LEVEL: "debug",
        },
        handler: "orders.handler",
      },
      name: "orders-api",
      region: "sa-east-1",
      runtime: {
        lambda: "nodejs22.x",
      },
      stage: "prod",
    },
  });
  const service = api(app);

  expect(service.name).toBe("orders-http");
  expect(service.config.name).toBe("orders-api");
  expect(service.config.api).toEqual({
    function: "api",
    name: "orders-http",
    protocol: "http",
    routes: ["GET /orders", "POST /orders"],
  });
  expect(service.config.cloudFormation.handler).toBe("orders.handler");
  expect(service.config.cloudFormation.environment).toEqual({
    LOG_LEVEL: "debug",
  });
});

test("activates local Function Registry invocation through createGateway", async () => {
  const functions = defineFunctions({
    greet: defineFunction({
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

  const gateway = createGateway({
    config: {
      name: "greeting-api",
    },
    functions,
  });

  expect(gateway.fetch).toBeFunction();
  await expect(functions.invoke("greet", { name: "Victor" })).resolves.toEqual({
    message: "hello Victor",
  });
});

test("rejects duplicate Function Registry configuration on createGateway", () => {
  const functions = defineFunctions({
    ping: defineFunction({
      handler: () => ({ ok: true }),
      output: passthroughSchema<{ ok: boolean }>(),
    }),
  });

  expect(() =>
    createGateway({
      config: {
        functions,
        name: "duplicate-functions-api",
      },
      functions,
    })
  ).toThrow(VokeConfigError);
  expect(() =>
    createGateway({
      config: {
        functions,
        name: "duplicate-functions-api",
      },
      functions,
    })
  ).toThrow("Pass functions either top-level or in config.functions, not both");
});

test("handles a Lambda HTTP API v2 GET request", async () => {
  const app = new Hono();

  app.get("/hello/:name", (c) =>
    c.json({
      data: {
        greeting: c.req.query("greeting"),
        name: c.req.param("name"),
      },
    })
  );

  const vokeApi = api(app, { name: "hello-api" });
  const response = await vokeApi.handler(
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
  const app = new Hono();

  app.post("/echo", async (c) => c.json({ data: await c.req.json() }));

  const response = await handleAwsLambdaRequest(
    app,
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

test("composes route modules and exposes config/context helpers", async () => {
  const routes = new Hono<VokeEnv>();

  routes.get("/:id", (c) =>
    json({
      id: c.req.param("id"),
      requestId: awsContext(c)?.awsRequestId,
      service: getConfig(c).name,
    })
  );

  const app = createApiApp({
    config: {
      name: "users-api",
      region: "sa-east-1",
      stage: "test",
    },
    routes: [routeModule(routes, { basePath: "/users" })],
  });
  const service = api(app, { name: "users-api" });
  const response = await service.handler(
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
  expect(JSON.parse(response.body)).toEqual({
    data: {
      id: "usr_1",
      requestId: "req_123",
      service: "users-api",
    },
  });
});

test("returns default JSON errors for missing routes", async () => {
  const app = createApiApp({ config: { name: "missing-route-api" } });
  const service = api(app);
  const response = await service.handler(
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
  const directory = `/private/tmp/voke-created-api-${crypto.randomUUID()}`;

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
  expect(index).toContain("createFunctions");
  expect(index).toContain("http");
  expect(index).toContain("voke");
  expect(index).toContain("voke.config");
  expect(index).toContain("routes: [healthRoute]");
  expect(healthRoute).toContain("healthRoute");
  expect(testFile).toContain("responds to health checks");
});

test("generated starter test suite passes with local package links", async () => {
  const directory = `/private/tmp/voke-created-api-smoke-${crypto.randomUUID()}`;

  await createApiProject({
    directory,
    name: "created-api-smoke",
  });
  await Bun.$`mkdir -p ${directory}/node_modules`;
  await Bun.$`ln -s ${`${import.meta.dir}/..`} ${`${directory}/node_modules/voke`}`;
  await Bun.$`ln -s ${`${import.meta.dir}/../node_modules/hono`} ${`${directory}/node_modules/hono`}`;

  const process = Bun.spawn(["bun", "test"], {
    cwd: directory,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await process.exited;
  const stderr = await new Response(process.stderr).text();
  const stdout = await new Response(process.stdout).text();

  expect(`${stdout}\n${stderr}`).toContain("responds to health checks");
  expect(exitCode).toBe(0);
});

test("normalizes project and CloudFormation settings through defineConfig", () => {
  const config = defineConfig({
    build: {
      outdir: "./build",
    },
    cloudFormation: {
      environment: {
        LOG_LEVEL: "debug",
      },
      handler: "api.handler",
      out: "./build/stack.json",
      resources: {
        ordersTable: dynamodbTable({ partitionKey: "id" }),
      },
    },
    entrypoint: "./src/api.ts",
    name: "orders-api",
    region: "sa-east-1",
    stage: "prod",
  });

  expect(config).toEqual({
    api: {
      function: "api",
      name: "orders-api",
      protocol: "http",
      routes: ["$default"],
    },
    build: {
      entrypoints: ["./src/api.ts"],
      outdir: "./build",
      target: "bun",
    },
    cloudFormation: {
      environment: {
        LOG_LEVEL: "debug",
      },
      handler: "api.handler",
      out: "./build/stack.json",
      resources: {
        ordersTable: dynamodbTable({ partitionKey: "id" }),
      },
    },
    dev: {
      entrypoint: "./src/api.ts",
      environment: {},
    },
    entrypoint: "./src/api.ts",
    functions: {},
    local: {
      provider: expect.objectContaining({
        name: "floci",
      }),
      providerOptional: true,
    },
    name: "orders-api",
    region: "sa-east-1",
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

test("exposes AWS resource helpers from voke/aws", () => {
  const template = synthesizeCloudFormation(
    defineConfig({
      cloudFormation: {
        resources: {
          jobsQueue: sqsQueue(),
          notificationsTopic: snsTopic(),
          ordersTable: dynamodbTable({ partitionKey: "id" }),
          publicConfig: ssmParameter({ value: "enabled" }),
          signingSecret: secret(),
          uploadsBucket: s3Bucket(),
        },
      },
      name: "aws-subpath-api",
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
  const directory = `/private/tmp/voke-config-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";
import { sqsQueue } from "${import.meta.dir}/../src/aws.ts";

export default defineConfig({
  name: "configured-api",
  stage: "test",
  region: "sa-east-1",
  entrypoint: "./src/service.ts",
  cloudFormation: {
    out: "./build/template.json",
    environment: {
      LOG_LEVEL: "info",
    },
    resources: {
      jobsQueue: sqsQueue(),
    },
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
  expect(config.cloudFormation.environment).toEqual({ LOG_LEVEL: "info" });
  expect(Object.keys(config.cloudFormation.resources)).toEqual(["jobsQueue"]);
});

test("synth CLI reads voke.config.ts and writes the configured template path", async () => {
  const directory = `/private/tmp/voke-synth-config-${crypto.randomUUID()}`;
  const out = `${directory}/build/template.json`;
  const configPath = `${directory}/voke.config.ts`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";
import { sqsQueue } from "${import.meta.dir}/../src/aws.ts";

export default defineConfig({
  name: "configured-synth",
  stage: "qa",
  region: "sa-east-1",
  entrypoint: "./src/service.ts",
  cloudFormation: {
    out: "${out}",
    environment: {
      LOG_LEVEL: "info",
    },
    resources: {
      jobsQueue: sqsQueue(),
    },
  },
});
`
  );

  await runCli(["synth", "--config", configPath]);

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

test("experimental deploy and remove CLI commands default to voke.config.ts", async () => {
  const directory = `/private/tmp/voke-deploy-config-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;
  const calls: string[][] = [];

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";

export default defineConfig({
  name: "configured-deploy",
  stage: "qa",
  region: "sa-east-1",
  cloudFormation: {
    out: "${directory}/template.json",
  },
});
`
  );

  await runCli(["experimental", "deploy", "--config", configPath], {
    run: (command) => {
      calls.push(command);
    },
  });
  await runCli(["experimental", "remove", "--config", configPath], {
    run: (command) => {
      calls.push(command);
    },
  });

  expect(calls).toEqual([
    [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "configured-deploy-qa",
      "--template-file",
      `${directory}/template.json`,
      "--capabilities",
      "CAPABILITY_IAM",
      "--region",
      "sa-east-1",
    ],
    [
      "aws",
      "cloudformation",
      "delete-stack",
      "--stack-name",
      "configured-deploy-qa",
      "--region",
      "sa-east-1",
    ],
  ]);
});

test("runs create and build through the CLI parser", async () => {
  const directory = `/private/tmp/voke-cli-api-${crypto.randomUUID()}`;
  const buildDirectory = `/private/tmp/voke-cli-build-${crypto.randomUUID()}`;
  const entrypoint = `${directory}/src/smoke.ts`;

  await runCli(["create", "api", "cli-api", directory]);
  await Bun.write(
    entrypoint,
    "export default { fetch: () => new Response('ok') };\n"
  );
  await runCli(["build", entrypoint, buildDirectory]);

  expect(await Bun.file(`${directory}/src/routes/health.ts`).exists()).toBe(
    true
  );
  expect(await Bun.file(`${buildDirectory}/smoke.js`).exists()).toBe(true);
});

test("synthesizes a CloudFormation template with API, Lambda, IAM, resources, bindings, and outputs", () => {
  const template = synthesizeCloudFormation(
    defineConfig({
      cloudFormation: {
        environment: {
          LOG_LEVEL: "info",
        },
        resources: {
          eventsQueue: sqsQueue(),
          orderCreatedTopic: snsTopic(),
          ordersTable: dynamodbTable({ partitionKey: "pk", sortKey: "sk" }),
          publicConfig: ssmParameter({ value: "enabled" }),
          signingSecret: secret(),
          uploadsBucket: s3Bucket(),
        },
      },
      entrypoint: "./src/index.ts",
      name: "orders-api",
      region: "sa-east-1",
      stage: "prod",
    })
  );
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
    "Fn::Sub": `https://\${Api}.execute-api.\${AWS::Region}.amazonaws.com/prod`,
  });
  expect(ordersTableOutput.Value).toEqual({ Ref: "OrdersTable" });
});

test("matches the CloudFormation snapshot for a minimal API stack", async () => {
  const template = synthesizeCloudFormation({
    entrypoint: "./src/index.ts",
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

  restoreEnv("VOKE_RESOURCE_ORDERS_TABLE_NAME", previous.table);
  restoreEnv("VOKE_RESOURCE_EVENTS_QUEUE_URL", previous.queue);
  restoreEnv("AWS_REGION", previous.region);
  restoreEnv("VOKE_AWS_ENDPOINT_URL", previous.endpoint);
});

test("runs synth and experimental deploy/remove through the CLI parser", async () => {
  const directory = `/private/tmp/voke-cfn-${crypto.randomUUID()}`;
  const templatePath = `${directory}/template.json`;
  const commands: string[][] = [];

  await runCli([
    "synth",
    "--name",
    "orders-api",
    "--stage",
    "prod",
    "--out",
    templatePath,
  ]);
  await runCli(
    [
      "experimental",
      "deploy",
      "--name",
      "orders-api",
      "--stage",
      "prod",
      "--template",
      templatePath,
    ],
    {
      run: (command) => {
        commands.push(command);
      },
    }
  );
  await runCli(
    ["experimental", "remove", "--name", "orders-api", "--stage", "prod"],
    {
      run: (command) => {
        commands.push(command);
      },
    }
  );

  const template = await Bun.file(templatePath).json();

  expect(template.Resources.Function.Type).toBe("AWS::Lambda::Function");
  expect(commands).toEqual([
    [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "orders-api-prod",
      "--template-file",
      templatePath,
      "--capabilities",
      "CAPABILITY_IAM",
      "--region",
      "us-east-1",
    ],
    [
      "aws",
      "cloudformation",
      "delete-stack",
      "--stack-name",
      "orders-api-prod",
      "--region",
      "us-east-1",
    ],
  ]);
});
