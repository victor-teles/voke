import { expect, test } from "bun:test";

import {
  createAwsClientConfig,
  dynamodbTable,
  s3Bucket,
  sqsQueue,
} from "../src/aws";
import { runCli } from "../src/cli";
import { synthesizeCloudFormation } from "../src/cloudformation";
import { defineConfig } from "../src/config";
import {
  createFlociComposeConfig,
  createFlociLocalProvider,
  createLocalAwsEnvironment,
  createLocalBootstrapPlan,
  createLocalResourceBindings,
  LocalProviderError,
} from "../src/local";
import type { LocalProvider } from "../src/local";

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
  expect(createFlociComposeConfig()).toBe(`services:
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

  const compose = createFlociComposeConfig({
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

test("exposes Floci as the default local provider contract", async () => {
  const provider = createFlociLocalProvider({
    accessKeyId: "local-key",
    accountId: "123456789012",
    dataDirectory: ".voke/local/floci",
    endpoint: "http://localhost:4567",
    region: "sa-east-1",
    secretAccessKey: "local-secret",
    sessionToken: "local-session",
  });
  const environment = provider.environment();
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
  expect(provider.startCommand({ composePath: "compose.yml" })).toEqual([
    "docker",
    "compose",
    "-f",
    "compose.yml",
    "up",
    "-d",
  ]);
  expect(provider.stopCommand({ composePath: "compose.yml" })).toEqual([
    "docker",
    "compose",
    "-f",
    "compose.yml",
    "down",
  ]);
  expect(provider.resetCommand({ composePath: "compose.yml" })).toEqual([
    "docker",
    "compose",
    "-f",
    "compose.yml",
    "down",
    "-v",
  ]);
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

test("derives Floci local bindings from configured endpoint and account", () => {
  const provider = createFlociLocalProvider({
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

test("keeps provided templates as a local bootstrap escape hatch", async () => {
  const templatePath = `/private/tmp/voke-local-template-escape-${crypto.randomUUID()}/template.json`;
  const template = synthesizeCloudFormation({
    name: "escape-api",
    stage: "sandbox",
  });

  const plan = await createLocalBootstrapPlan({
    name: "escape-api",
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

test("delegates local environment and bootstrap to a custom provider", async () => {
  const templatePath = `/private/tmp/voke-custom-provider-${crypto.randomUUID()}/template.json`;
  const customProvider: LocalProvider = {
    bootstrapPlan: (options) => ({
      commands: [["customctl", "apply", options.name, options.templatePath]],
      environment: options.environment,
    }),
    composeConfig: () => "services:\n  custom:\n    image: custom/aws\n",
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
    name: "custom-local-aws",
    resetCommand: ({ composePath }) => ["customctl", "reset", composePath],
    startCommand: ({ composePath }) => ["customctl", "start", composePath],
    stopCommand: ({ composePath }) => ["customctl", "stop", composePath],
  };
  const config = defineConfig({
    local: {
      provider: customProvider,
    },
    name: "orders-api",
    region: "us-west-2",
    resources: {
      ordersQueue: sqsQueue(),
    },
  });

  const environment = createLocalAwsEnvironment({
    provider: customProvider,
    region: "us-west-2",
  });
  const plan = await createLocalBootstrapPlan({
    config,
    templatePath,
  });
  const bindings = createLocalResourceBindings(
    await Bun.file(templatePath).json(),
    {
      accountId: config.local.provider.defaults.accountId,
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

test("runs CLI local commands through a configured custom provider", async () => {
  const directory = `/private/tmp/voke-local-custom-cli-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;
  const composePath = `${directory}/compose.yml`;
  const templatePath = `${directory}/template.json`;
  const calls: { command: string[]; env?: Record<string, string> }[] = [];

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";

const provider = {
  name: "custom-local-aws",
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
  composeConfig: () => "services:\\n  custom:\\n    image: custom/aws\\n",
  bootstrapPlan: ({ environment, name, templatePath }) => ({
    commands: [["customctl", "apply", name, templatePath]],
    environment,
  }),
  startCommand: ({ composePath }) => ["customctl", "start", composePath],
  stopCommand: ({ composePath }) => ["customctl", "stop", composePath],
  resetCommand: ({ composePath }) => ["customctl", "reset", composePath],
};

export default defineConfig({
  name: "custom-api",
  local: {
    provider,
  },
});
`
  );

  await runCli(
    ["local", "start", "--config", configPath, "--compose", composePath],
    {
      run: (command, options) => {
        calls.push({ command, env: options?.env });
      },
    }
  );
  await runCli(
    ["local", "bootstrap", "--config", configPath, "--template", templatePath],
    {
      run: (command, options) => {
        calls.push({ command, env: options?.env });
      },
    }
  );
  await runCli(
    ["local", "stop", "--config", configPath, "--compose", composePath],
    {
      run: (command, options) => {
        calls.push({ command, env: options?.env });
      },
    }
  );
  await runCli(
    ["local", "reset", "--config", configPath, "--compose", composePath],
    {
      run: (command, options) => {
        calls.push({ command, env: options?.env });
      },
    }
  );

  expect(await Bun.file(composePath).text()).toBe(
    "services:\n  custom:\n    image: custom/aws\n"
  );
  expect(calls).toEqual([
    {
      command: ["customctl", "start", composePath],
      env: undefined,
    },
    {
      command: ["customctl", "apply", "custom-api", templatePath],
      env: {
        AWS_ACCESS_KEY_ID: "custom",
        AWS_DEFAULT_REGION: "us-east-1",
        AWS_ENDPOINT_URL: "http://localhost:9999",
        AWS_REGION: "us-east-1",
        AWS_SECRET_ACCESS_KEY: "custom",
        AWS_SESSION_TOKEN: "custom",
        VOKE_AWS_ENDPOINT_URL: "http://localhost:9999",
        VOKE_INVOKE_RUNTIME: "local",
        VOKE_LOCAL_PROVIDER: "custom-local-aws",
      },
    },
    {
      command: ["customctl", "stop", composePath],
      env: undefined,
    },
    {
      command: ["customctl", "reset", composePath],
      env: undefined,
    },
  ]);
});

test("wraps Floci local start failures with actionable Docker Compose guidance", async () => {
  const directory = `/private/tmp/voke-local-floci-failure-${crypto.randomUUID()}`;
  const composePath = `${directory}/docker-compose.yml`;

  await expect(
    runCli(["local", "start", "--compose", composePath], {
      run: () => {
        throw new Error("docker is not running");
      },
    })
  ).rejects.toThrow(LocalProviderError);

  await expect(
    runCli(["local", "start", "--compose", composePath], {
      run: () => {
        throw new Error("docker is not running");
      },
    })
  ).rejects.toThrow(
    `Voke local start failed while running: docker compose -f ${composePath} up -d. docker is not running
Floci is Voke's default optional local AWS provider. Make sure Docker Compose is installed and Docker is running, then retry "voke local start". You can also configure local.provider in voke.config.ts.`
  );
});

test("wraps Floci bootstrap failures with start guidance and preserves env", async () => {
  const templatePath = `/private/tmp/voke-local-bootstrap-failure-${crypto.randomUUID()}/template.json`;
  let commandEnv: Record<string, string> | undefined;

  await expect(
    runCli(
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
        run: (_command, options) => {
          commandEnv = options?.env;
          throw new Error("cannot reach local CloudFormation endpoint");
        },
      }
    )
  ).rejects.toThrow(
    `Floci is Voke's default optional local AWS provider. Make sure Floci is running with "voke local start", then retry "voke local bootstrap". You can also configure local.provider in voke.config.ts.`
  );

  expect(commandEnv).toEqual(createLocalAwsEnvironment());
});

test("wraps custom provider failures without Floci-specific guidance", async () => {
  const directory = `/private/tmp/voke-local-custom-failure-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;
  const composePath = `${directory}/compose.yml`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index.ts";

const provider = {
  name: "custom-local-aws",
  defaults: {
    accountId: "111111111111",
    endpoint: "http://localhost:9999",
    region: "us-west-2",
  },
  environment: () => ({
    AWS_ACCESS_KEY_ID: "custom",
    AWS_DEFAULT_REGION: "us-west-2",
    AWS_ENDPOINT_URL: "http://localhost:9999",
    AWS_REGION: "us-west-2",
    AWS_SECRET_ACCESS_KEY: "custom",
    AWS_SESSION_TOKEN: "custom",
    VOKE_AWS_ENDPOINT_URL: "http://localhost:9999",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "custom-local-aws",
  }),
  composeConfig: () => "services:\\n  custom:\\n    image: custom/aws\\n",
  bootstrapPlan: ({ environment }) => ({
    commands: [["customctl", "apply"]],
    environment,
  }),
  startCommand: ({ composePath }) => ["customctl", "start", composePath],
  stopCommand: ({ composePath }) => ["customctl", "stop", composePath],
  resetCommand: ({ composePath }) => ["customctl", "reset", composePath],
};

export default defineConfig({
  name: "custom-api",
  local: {
    provider,
  },
});
`
  );

  await expect(
    runCli(
      ["local", "start", "--config", configPath, "--compose", composePath],
      {
        run: () => {
          throw new Error("custom provider unavailable");
        },
      }
    )
  ).rejects.toThrow(
    `Voke local start failed while running: customctl start ${composePath}. custom provider unavailable
Local provider: custom-local-aws. Check this provider's local command configuration.`
  );
});
