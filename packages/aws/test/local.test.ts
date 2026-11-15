import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVokeModel, defineConfig } from "voke";
import type { ProviderCommandRunOptions } from "voke";

import {
  dynamodbTable,
  kinesisStream,
  s3Bucket,
  sqsQueue,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import { aws, createAwsClientConfig } from "../src/index";
import {
  createLocalAwsEnvironment,
  createLocalBootstrapPlan,
  createLocalResourceBindings,
  createLocalWorkflow,
  floci,
  LocalProviderError,
} from "../src/local";
import type { LocalProvider } from "../src/local";

const scratchPath = (name: string): string =>
  join(tmpdir(), `${name}-${crypto.randomUUID()}`);

const customProvider: LocalProvider = {
  bindings: "guessed",
  bootstrapPlan: (options) => ({
    commands: [["customctl", "apply", options.name, options.templatePath]],
    environment: options.environment,
  }),
  defaults: {
    accountId: "111111111111",
    endpoint: "http://localhost:9999",
    region: "us-west-2",
  },
  environment: (options = {}) => ({
    AWS_ACCESS_KEY_ID: "custom",
    AWS_DEFAULT_REGION: options.region ?? "us-west-2",
    AWS_ENDPOINT_URL: options.endpoint ?? "http://localhost:9999",
    AWS_REGION: options.region ?? "us-west-2",
    AWS_SECRET_ACCESS_KEY: "custom",
    AWS_SESSION_TOKEN: "custom",
    VOKE_AWS_ENDPOINT_URL: options.endpoint ?? "http://localhost:9999",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "custom-local-aws",
  }),
  files: ({ options }) => ({
    [options.compose ?? "compose.yml"]:
      "services:\n  custom:\n    image: custom/aws\n",
  }),
  name: "custom-local-aws",
  resetCommands: ({ options }) => [
    ["customctl", "reset", options.compose ?? ""],
  ],
  startCommands: ({ options }) => [
    ["customctl", "start", options.compose ?? ""],
  ],
  stopCommands: ({ options }) => [["customctl", "stop", options.compose ?? ""]],
};

const lifecycle = (options: Record<string, string> = {}) => ({
  directory: "/project/.voke/local/floci",
  options,
  region: "us-east-1",
});

test("creates a Floci-ready local AWS environment", async () => {
  const env = await createLocalAwsEnvironment({
    endpoint: "http://localhost:4566",
    provider: floci(),
    region: "sa-east-1",
  });

  expect(env).toEqual({
    AWS_ACCESS_KEY_ID: "test",
    AWS_DEFAULT_REGION: "sa-east-1",
    AWS_ENDPOINT_URL: "http://localhost:4566",
    AWS_REGION: "sa-east-1",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_SESSION_TOKEN: "test",
    VOKE_AWS_ENDPOINT_URL: "http://localhost:4566",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "floci",
  });
});

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
};

test("uses AWS_ENDPOINT_URL as the standard local AWS SDK endpoint", () => {
  const previous = {
    endpoint: process.env.AWS_ENDPOINT_URL,
    region: process.env.AWS_REGION,
    vokeEndpoint: process.env.VOKE_AWS_ENDPOINT_URL,
  };

  process.env.AWS_ENDPOINT_URL = "http://localhost:4566";
  Reflect.deleteProperty(process.env, "VOKE_AWS_ENDPOINT_URL");
  process.env.AWS_REGION = "us-west-2";

  try {
    expect(createAwsClientConfig()).toEqual({
      endpoint: "http://localhost:4566",
      region: "us-west-2",
    });
  } finally {
    restore("AWS_ENDPOINT_URL", previous.endpoint);
    restore("VOKE_AWS_ENDPOINT_URL", previous.vokeEndpoint);
    restore("AWS_REGION", previous.region);
  }
});

test("generates a Docker Compose file for Floci", () => {
  expect(floci().composeConfig()).toBe(`services:
  floci:
    image: floci/floci:latest
    ports:
      - "4566:4566"
    environment:
      - FLOCI_DEFAULT_REGION=us-east-1
      - FLOCI_STORAGE_MODE=persistent
    volumes:
      - .voke/local/data:/app/data
`);

  const compose = floci().composeConfig({
    dataDirectory: ".voke/local/data",
    hostname: "floci.local",
    image: "ghcr.io/acme/floci:v1",
    port: 4567,
    region: "sa-east-1",
    storageMode: "memory",
  });

  expect(compose).toBe(`services:
  floci:
    image: ghcr.io/acme/floci:v1
    ports:
      - "4567:4566"
    environment:
      - FLOCI_DEFAULT_REGION=sa-east-1
      - FLOCI_STORAGE_MODE=memory
      - FLOCI_HOSTNAME=floci.local
    volumes:
      - .voke/local/data:/app/data
`);
});

test("exposes Floci as the default Local AWS Provider contract", async () => {
  const provider = floci({
    accessKeyId: "local-key",
    accountId: "123456789012",
    dataDirectory: ".voke/local/floci",
    endpoint: "http://localhost:4567",
    region: "sa-east-1",
    secretAccessKey: "local-secret",
    sessionToken: "local-session",
  });
  const environment = await provider.environment();
  const plan = await provider.bootstrapPlan({
    environment,
    name: "orders-api",
    region: "sa-east-1",
    stage: "local",
    template: synthesizeCloudFormation({ name: "orders-api" }),
    templatePath: ".voke/local/cloudformation.json",
  });

  expect(provider.name).toBe("floci");
  expect(provider.defaults).toEqual({
    accountId: "123456789012",
    endpoint: "http://localhost:4567",
    region: "sa-east-1",
  });
  expect(environment).toEqual({
    AWS_ACCESS_KEY_ID: "local-key",
    AWS_DEFAULT_REGION: "sa-east-1",
    AWS_ENDPOINT_URL: "http://localhost:4567",
    AWS_REGION: "sa-east-1",
    AWS_SECRET_ACCESS_KEY: "local-secret",
    AWS_SESSION_TOKEN: "local-session",
    VOKE_AWS_ENDPOINT_URL: "http://localhost:4567",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "floci",
  });
  expect(provider.composeConfig()).toContain(".voke/local/floci:/app/data");
  const compose = lifecycle({ compose: "compose.yml" });

  expect(provider.bindings).toBe("guessed");
  expect(provider.unsetEnvironment).toBeUndefined();
  expect(provider.startCommands(compose)).toEqual([
    ["docker", "compose", "-f", "compose.yml", "up", "-d"],
  ]);
  expect(provider.stopCommands(compose)).toEqual([
    ["docker", "compose", "-f", "compose.yml", "down"],
  ]);
  expect(provider.resetCommands(compose)).toEqual([
    ["docker", "compose", "-f", "compose.yml", "down", "-v"],
  ]);
  expect(provider.files(lifecycle())).toEqual({
    ".voke/local/docker-compose.yml": provider.composeConfig({
      dataDirectory: ".voke/local/data",
    }),
  });
  expect(plan.commands[0]).toContain("orders-api-local");
  expect(plan.environment.VOKE_LOCAL_PROVIDER).toBe("floci");
});

test("derives local resource bindings from a synthesized stack", () => {
  const template = synthesizeCloudFormation({
    name: "orders-api",
    resources: {
      ordersQueue: sqsQueue(),
      ordersTable: dynamodbTable({ partitionKey: "id" }),
      uploadsBucket: s3Bucket(),
    },
    stage: "local",
  });

  expect(createLocalResourceBindings(template)).toEqual({
    VOKE_RESOURCE_ORDERS_QUEUE_URL:
      "http://localhost:4566/000000000000/OrdersQueue",
    VOKE_RESOURCE_ORDERS_TABLE_NAME: "OrdersTable",
    VOKE_RESOURCE_UPLOADS_BUCKET_NAME: "UploadsBucket",
  });
});

test("derives the local name binding of a Kinesis stream", () => {
  const template = synthesizeCloudFormation({
    name: "clicks-api",
    resources: { clicksStream: kinesisStream() },
    stage: "local",
  });

  expect(createLocalResourceBindings(template)).toEqual({
    VOKE_RESOURCE_CLICKS_STREAM_NAME: "ClicksStream",
  });
});

test("derives Floci local bindings from configured endpoint and account", () => {
  const provider = floci({
    accountId: "123456789012",
    endpoint: "http://localhost:4567",
    region: "sa-east-1",
  });
  const template = synthesizeCloudFormation({
    name: "orders-api",
    resources: {
      ordersQueue: sqsQueue(),
    },
    stage: "local",
  });

  expect(
    createLocalResourceBindings(template, {
      accountId: provider.defaults.accountId,
      endpoint: provider.defaults.endpoint,
      region: provider.defaults.region,
    })
  ).toEqual({
    VOKE_RESOURCE_ORDERS_QUEUE_URL:
      "http://localhost:4567/123456789012/OrdersQueue",
  });
});

test("creates a local bootstrap plan for CloudFormation through Floci", async () => {
  const templatePath = join(scratchPath("voke-local"), "template.json");
  const template = synthesizeCloudFormation({
    name: "orders-api",
    resources: {
      ordersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });

  const plan = await createLocalBootstrapPlan({
    name: "orders-api",
    provider: floci(),
    region: "us-east-1",
    stage: "local",
    template,
    templatePath,
  });

  expect(await Bun.file(templatePath).exists()).toBe(true);
  expect(plan.environment.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
  expect(plan.commands).toEqual([
    [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "orders-api-local",
      "--template-file",
      templatePath,
      "--capabilities",
      "CAPABILITY_IAM",
      "--region",
      "us-east-1",
    ],
  ]);
});

test("keeps provided templates as a local bootstrap escape hatch", async () => {
  const templatePath = join(
    scratchPath("voke-local-template-escape"),
    "template.json"
  );
  const template = synthesizeCloudFormation({
    name: "escape-api",
    stage: "sandbox",
  });

  const plan = await createLocalBootstrapPlan({
    name: "escape-api",
    provider: floci(),
    region: "us-east-1",
    stage: "sandbox",
    template,
    templatePath,
  });
  const writtenTemplate = await Bun.file(templatePath).json();

  expect(writtenTemplate).toEqual(template);
  expect(plan.commands).toEqual([
    [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "escape-api-sandbox",
      "--template-file",
      templatePath,
      "--capabilities",
      "CAPABILITY_IAM",
      "--region",
      "us-east-1",
    ],
  ]);
});

test("creates a local bootstrap plan by synthesizing the project model", async () => {
  const templatePath = join(scratchPath("voke-local-config"), "template.json");
  const config = defineConfig({
    entrypoint: "./src/index.ts",
    environment: {
      LOG_LEVEL: "info",
    },
    name: "orders-api",
    region: "sa-east-1",
    resources: {
      ordersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });

  const plan = await createLocalBootstrapPlan({
    model: createVokeModel(config),
    name: config.name,
    provider: floci(),
    region: config.region,
    stage: config.stage,
    templatePath,
  });
  const template = await Bun.file(templatePath).json();

  expect(template.Description).toBe("Voke stack for orders-api (local)");
  // Local bootstrap provisions infrastructure only; Functions run in the local Gateway.
  expect(template.Resources.OrdersTable.Type).toBe("AWS::DynamoDB::Table");
  expect(template.Resources.Function).toBeUndefined();
  expect(template.Outputs.OrdersTableName.Value).toEqual({
    Ref: "OrdersTable",
  });
  expect(plan.environment.AWS_REGION).toBe("sa-east-1");
  expect(plan.commands).toEqual([
    [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "orders-api-local",
      "--template-file",
      templatePath,
      "--capabilities",
      "CAPABILITY_IAM",
      "--region",
      "sa-east-1",
    ],
  ]);
});

test("delegates local environment and bootstrap to a custom Local AWS Provider", async () => {
  const templatePath = join(
    scratchPath("voke-custom-provider"),
    "template.json"
  );
  const config = defineConfig({
    name: "orders-api",
    region: "us-west-2",
    resources: {
      ordersQueue: sqsQueue(),
    },
  });

  const environment = await createLocalAwsEnvironment({
    provider: customProvider,
    region: "us-west-2",
  });
  const plan = await createLocalBootstrapPlan({
    model: createVokeModel(config),
    name: config.name,
    provider: customProvider,
    region: config.region,
    stage: config.stage,
    templatePath,
  });
  const bindings = createLocalResourceBindings(
    await Bun.file(templatePath).json(),
    {
      accountId: customProvider.defaults.accountId,
      endpoint: plan.environment.AWS_ENDPOINT_URL,
      region: config.region,
    }
  );

  expect(environment).toMatchObject({
    AWS_ENDPOINT_URL: "http://localhost:9999",
    VOKE_LOCAL_PROVIDER: "custom-local-aws",
  });
  expect(plan).toEqual({
    commands: [["customctl", "apply", "orders-api", templatePath]],
    environment,
  });
  expect(bindings.VOKE_RESOURCE_ORDERS_QUEUE_URL).toBe(
    "http://localhost:9999/111111111111/OrdersQueue"
  );
});

test("aws({ local }) uses the given Local AWS Provider for voke dev", async () => {
  const provider = aws({ local: customProvider });
  const config = defineConfig({
    name: "orders-api",
    provider,
    resources: { ordersQueue: sqsQueue() },
  });
  const devEnvironment = await provider.local?.devEnvironment?.({
    config,
    model: createVokeModel(config),
    region: "us-west-2",
    stage: "local",
  });

  expect(devEnvironment?.environment).toMatchObject({
    AWS_ENDPOINT_URL: "http://localhost:9999",
    VOKE_LOCAL_PROVIDER: "custom-local-aws",
    VOKE_RESOURCE_ORDERS_QUEUE_URL:
      "http://localhost:9999/111111111111/OrdersQueue",
  });
  expect(aws().local?.workflow).toBeDefined();
});

test("the local workflow writes the compose file and runs start, stop, reset and bootstrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voke-local-workflow-"));
  const compose = join(directory, "compose.yml");
  const template = join(directory, "cloudformation.json");
  const calls: { command: string[]; options?: ProviderCommandRunOptions }[] =
    [];
  const config = defineConfig({
    name: "orders-api",
    region: "sa-east-1",
    resources: { ordersQueue: sqsQueue() },
    stage: "local",
  });
  const context = {
    config,
    model: createVokeModel(config),
    options: { compose, port: "4567", template },
    run: (command: string[], options?: ProviderCommandRunOptions) => {
      calls.push({ command, options });
    },
  };
  const workflow = createLocalWorkflow(floci(), { cwd: () => directory });

  try {
    await workflow.start(context);
    await workflow.stop(context);
    await workflow.reset(context);
    await workflow.bootstrap(context);

    expect(await Bun.file(compose).text()).toContain('"4567:4566"');
    expect(calls.map((call) => call.command)).toEqual([
      ["docker", "compose", "-f", compose, "up", "-d"],
      ["docker", "compose", "-f", compose, "down"],
      ["docker", "compose", "-f", compose, "down", "-v"],
      [
        "aws",
        "cloudformation",
        "deploy",
        "--stack-name",
        "orders-api-local",
        "--template-file",
        template,
        "--capabilities",
        "CAPABILITY_IAM",
        "--region",
        "sa-east-1",
      ],
    ]);
    expect(calls[3]?.options?.env?.AWS_ENDPOINT_URL).toBe(
      "http://localhost:4566"
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("wraps failing Floci commands in LocalProviderError with Docker Compose guidance", async () => {
  const config = defineConfig({ name: "orders-api" });
  const failure = await createLocalWorkflow(floci(), {
    cwd: () => scratchPath("voke-floci-stop"),
  })
    .stop({
      config,
      model: createVokeModel(config),
      options: { compose: "compose.yml" },
      run: () => {
        throw new Error("docker not found");
      },
    })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(LocalProviderError);
  expect((failure as Error).message).toBe(
    'Voke local stop failed while running: docker compose -f compose.yml down. docker not found\nFloci is an optional Local AWS Provider. Make sure Docker Compose is installed and Docker is running, then retry "voke local stop". You can also pass another Local AWS Provider: aws({ local: ... })'
  );
});
