import { expect, test } from "bun:test";

import { dynamodbTable, s3Bucket, sqsQueue } from "../src/aws";
import { runCli } from "../src/cli";
import {
  createAwsClientConfig,
  createFlociComposeConfig,
  createLocalAwsEnvironment,
  createLocalBootstrapPlan,
  createLocalResourceBindings,
  defineConfig,
  synthesizeCloudFormation,
} from "../src/index";

const restoreEnv = (name: string, value?: string): void => {
  Bun.env[name] = value;
};

test("creates a Floci-ready local AWS environment", () => {
  const env = createLocalAwsEnvironment({
    endpoint: "http://localhost:4566",
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

test("uses AWS_ENDPOINT_URL as the standard local AWS SDK endpoint", () => {
  const previous = {
    endpoint: Bun.env.AWS_ENDPOINT_URL,
    region: Bun.env.AWS_REGION,
    vokeEndpoint: Bun.env.VOKE_AWS_ENDPOINT_URL,
  };

  Bun.env.AWS_ENDPOINT_URL = "http://localhost:4566";
  restoreEnv("VOKE_AWS_ENDPOINT_URL");
  Bun.env.AWS_REGION = "us-west-2";

  expect(createAwsClientConfig()).toEqual({
    endpoint: "http://localhost:4566",
    region: "us-west-2",
  });

  restoreEnv("AWS_ENDPOINT_URL", previous.endpoint);
  restoreEnv("VOKE_AWS_ENDPOINT_URL", previous.vokeEndpoint);
  restoreEnv("AWS_REGION", previous.region);
});

test("generates a Docker Compose file for Floci", () => {
  const compose = createFlociComposeConfig({
    dataDirectory: ".voke/local/data",
    image: "floci/floci:latest",
    port: 4566,
    region: "sa-east-1",
  });

  expect(compose).toContain("image: floci/floci:latest");
  expect(compose).toContain('"4566:4566"');
  expect(compose).toContain("FLOCI_DEFAULT_REGION=sa-east-1");
  expect(compose).toContain(".voke/local/data:/app/data");
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

test("creates a local bootstrap plan for CloudFormation through Floci", async () => {
  const templatePath = `/private/tmp/voke-local-${crypto.randomUUID()}/template.json`;
  const template = synthesizeCloudFormation({
    name: "orders-api",
    resources: {
      ordersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });

  const plan = await createLocalBootstrapPlan({
    name: "orders-api",
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

test("creates a local bootstrap plan by synthesizing from Voke config", async () => {
  const templatePath = `/private/tmp/voke-local-config-${crypto.randomUUID()}/template.json`;
  const config = defineConfig({
    cloudFormation: {
      environment: {
        LOG_LEVEL: "info",
      },
      resources: {
        ordersTable: dynamodbTable({ partitionKey: "id" }),
      },
    },
    entrypoint: "./src/index.ts",
    name: "orders-api",
    region: "sa-east-1",
    stage: "local",
  });

  const plan = await createLocalBootstrapPlan({
    config,
    templatePath,
  });
  const template = await Bun.file(templatePath).json();

  expect(template.Description).toBe("Voke stack for orders-api (local)");
  expect(template.Resources.Function.Metadata.VokeEntrypoint).toBe(
    "./src/index.ts"
  );
  expect(
    template.Resources.Function.Properties.Environment.Variables.LOG_LEVEL
  ).toBe("info");
  expect(
    template.Resources.Function.Properties.Environment.Variables
      .VOKE_RESOURCE_ORDERS_TABLE_NAME
  ).toEqual({
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

test("creates a local bootstrap plan by loading voke.config.ts", async () => {
  const directory = `/private/tmp/voke-local-config-file-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;
  const templatePath = `${directory}/.voke/local/cloudformation.json`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";
import { sqsQueue } from "${import.meta.dir}/../src/aws.ts";

export default defineConfig({
  name: "jobs-api",
  stage: "local",
  region: "sa-east-1",
  cloudFormation: {
    resources: {
      jobsQueue: sqsQueue(),
    },
  },
});
`
  );

  const plan = await createLocalBootstrapPlan({
    configPath,
    templatePath,
  });
  const template = await Bun.file(templatePath).json();

  expect(template.Description).toBe("Voke stack for jobs-api (local)");
  expect(
    template.Resources.Function.Properties.Environment.Variables
      .VOKE_RESOURCE_JOBS_QUEUE_URL
  ).toEqual({
    Ref: "JobsQueue",
  });
  expect(plan.commands[0]).toContain("jobs-api-local");
});

test("runs local start, stop, reset, and bootstrap through the CLI parser", async () => {
  const directory = `/private/tmp/voke-local-cli-${crypto.randomUUID()}`;
  const composePath = `${directory}/docker-compose.yml`;
  const templatePath = `${directory}/template.json`;
  const calls: { command: string[]; env?: Record<string, string> }[] = [];

  await runCli(["local", "start", "--compose", composePath], {
    run: (command, options) => {
      calls.push({ command, env: options?.env });
    },
  });
  await runCli(
    [
      "local",
      "bootstrap",
      "--name",
      "orders-api",
      "--stage",
      "local",
      "--template",
      templatePath,
    ],
    {
      run: (command, options) => {
        calls.push({ command, env: options?.env });
      },
    }
  );
  await runCli(["local", "stop", "--compose", composePath], {
    run: (command, options) => {
      calls.push({ command, env: options?.env });
    },
  });
  await runCli(["local", "reset", "--compose", composePath], {
    run: (command, options) => {
      calls.push({ command, env: options?.env });
    },
  });

  expect(await Bun.file(composePath).exists()).toBe(true);
  expect(await Bun.file(templatePath).exists()).toBe(true);
  expect(calls).toEqual([
    {
      command: ["docker", "compose", "-f", composePath, "up", "-d"],
      env: undefined,
    },
    {
      command: [
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
      env: createLocalAwsEnvironment(),
    },
    {
      command: ["docker", "compose", "-f", composePath, "down"],
      env: undefined,
    },
    {
      command: ["docker", "compose", "-f", composePath, "down", "-v"],
      env: undefined,
    },
  ]);
});
