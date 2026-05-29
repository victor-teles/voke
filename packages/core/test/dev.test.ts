import { expect, test } from "bun:test";

import { aws, dynamodbTable, sqsQueue } from "@voke/aws";

import { runCli } from "../src/cli";
import { defineConfig } from "../src/config";
import { createDevPlan } from "../src/dev";
import type { LocalProvider } from "../src/local";

test("creates a config-first Bun hot reload dev plan with local bindings", async () => {
  const directory = `/private/tmp/voke-dev-plan-${crypto.randomUUID()}`;
  const entrypoint = `${directory}/src/api.ts`;

  await Bun.$`mkdir -p ${directory}/src`;
  await Bun.write(entrypoint, "export const handler = () => undefined;\n");

  const plan = await createDevPlan(
    defineConfig({
      cloudFormation: {
        environment: {
          LOG_LEVEL: "debug",
        },
        resources: {
          eventsQueue: sqsQueue(),
          ordersTable: dynamodbTable(),
        },
      },
      dev: {
        environment: {
          FEATURE_FLAG: "enabled",
        },
      },
      entrypoint,
      name: "orders-api",
      provider: aws(),
      region: "sa-east-1",
      stage: "local",
    })
  );

  expect(plan).toEqual({
    command: ["bun", "--hot", entrypoint],
    entrypoint,
    environment: {
      AWS_ACCESS_KEY_ID: "test",
      AWS_DEFAULT_REGION: "sa-east-1",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "sa-east-1",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_SESSION_TOKEN: "test",
      FEATURE_FLAG: "enabled",
      LOG_LEVEL: "debug",
      VOKE_AWS_ENDPOINT_URL: "http://localhost:4566",
      VOKE_DEV_ORIGIN: "http://localhost:3000",
      VOKE_DEV_STARTED_AT: expect.any(String),
      VOKE_DEV_SUMMARY: "1",
      VOKE_INVOKE_RUNTIME: "local",
      VOKE_LOCAL_PROVIDER: "floci",
      VOKE_RESOURCE_EVENTS_QUEUE_URL:
        "http://localhost:4566/000000000000/EventsQueue",
      VOKE_RESOURCE_ORDERS_TABLE_NAME: "OrdersTable",
      VOKE_STAGE: "local",
    },
  });
});

test("dev plan reports missing entrypoints clearly", async () => {
  const missing = `/private/tmp/voke-dev-missing-${crypto.randomUUID()}/src/api.ts`;

  await expect(
    createDevPlan({
      entrypoint: missing,
      name: "missing-api",
    })
  ).rejects.toThrow(`Voke dev entrypoint not found: ${missing}`);
});

test("dev plan uses the configured local provider", async () => {
  const directory = `/private/tmp/voke-dev-custom-provider-${crypto.randomUUID()}`;
  const entrypoint = `${directory}/src/api.ts`;
  const provider: LocalProvider = {
    bootstrapPlan: ({ environment }) => ({
      commands: [],
      environment,
    }),
    composeConfig: () => "",
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
    resetCommand: () => [],
    startCommand: () => [],
    stopCommand: () => [],
  };

  await Bun.$`mkdir -p ${directory}/src`;
  await Bun.write(entrypoint, "export const handler = () => undefined;\n");

  const plan = await createDevPlan(
    defineConfig({
      entrypoint,
      local: {
        provider,
      },
      name: "orders-api",
      provider: aws(),
      resources: {
        eventsQueue: sqsQueue(),
      },
    })
  );

  expect(plan.environment).toMatchObject({
    AWS_ENDPOINT_URL: "http://localhost:9999",
    VOKE_LOCAL_PROVIDER: "custom-local-aws",
    VOKE_RESOURCE_EVENTS_QUEUE_URL:
      "http://localhost:9999/111111111111/EventsQueue",
  });
});

test("dev plan reports providers without local dev support when resources need bindings", async () => {
  const directory = `/private/tmp/voke-dev-provider-synth-${crypto.randomUUID()}`;
  const entrypoint = `${directory}/src/api.ts`;

  await Bun.$`mkdir -p ${directory}/src`;
  await Bun.write(entrypoint, "export const handler = () => undefined;\n");

  await expect(
    createDevPlan(
      defineConfig({
        entrypoint,
        name: "orders-api",
        provider: {
          name: "custom",
        },
        resources: {
          eventsQueue: sqsQueue(),
        },
      })
    )
  ).rejects.toThrow(
    'Provider "custom" does not support dev local environment.'
  );
});

test("dev plan delegates provider-specific local environment to provider local capability", async () => {
  const directory = `/private/tmp/voke-dev-provider-local-${crypto.randomUUID()}`;
  const entrypoint = `${directory}/src/api.ts`;

  await Bun.$`mkdir -p ${directory}/src`;
  await Bun.write(entrypoint, "export const handler = () => undefined;\n");

  const plan = await createDevPlan(
    defineConfig({
      entrypoint,
      name: "provider-local-api",
      provider: {
        local: {
          devEnvironment: ({ endpoint, region, stage }) => ({
            CUSTOM_ENDPOINT: endpoint ?? "none",
            CUSTOM_REGION: region,
            CUSTOM_STAGE: stage,
            VOKE_INVOKE_RUNTIME: "custom-local",
          }),
        },
        name: "custom",
        synthesis: {
          synthesize: () => ({
            Outputs: {},
            Resources: {},
          }),
        },
      },
      region: "sa-east-1",
      stage: "sandbox",
    }),
    { endpoint: "http://local.test" }
  );

  expect(plan.environment).toMatchObject({
    CUSTOM_ENDPOINT: "http://local.test",
    CUSTOM_REGION: "sa-east-1",
    CUSTOM_STAGE: "sandbox",
    VOKE_INVOKE_RUNTIME: "custom-local",
    VOKE_STAGE: "sandbox",
  });
  expect(plan.environment.AWS_ENDPOINT_URL).toBeUndefined();
});

test("dev plan exposes configured remote targets as environment", async () => {
  const directory = `/private/tmp/voke-dev-remotes-${crypto.randomUUID()}`;
  const entrypoint = `${directory}/src/api.ts`;

  await Bun.$`mkdir -p ${directory}/src`;
  await Bun.write(entrypoint, "export const handler = () => undefined;\n");

  const plan = await createDevPlan(
    defineConfig({
      entrypoint,
      name: "wallet",
      remotes: {
        users: {
          targets: {
            local: "http://localhost:3001",
          },
        },
        walletAudit: {
          targets: {
            local: {
              contract: "http://contracts.local/wallet-audit",
              origin: "http://localhost:3002",
            },
          },
        },
      },
    })
  );

  expect(plan.environment).toMatchObject({
    VOKE_REMOTE_USERS_CONTRACT_URL: "http://localhost:3001/_voke/contract",
    VOKE_REMOTE_USERS_ORIGIN: "http://localhost:3001",
    VOKE_REMOTE_WALLET_AUDIT_CONTRACT_URL:
      "http://contracts.local/wallet-audit",
    VOKE_REMOTE_WALLET_AUDIT_ORIGIN: "http://localhost:3002",
  });
});

test("dev CLI reads config by default and lets flags override one-off runs", async () => {
  const directory = `/private/tmp/voke-dev-cli-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;
  const apiEntrypoint = `${directory}/src/api.ts`;
  const workerEntrypoint = `${directory}/src/worker.ts`;
  const calls: {
    command: string[];
    env?: Record<string, string>;
    stdoutFilter?: (line: string) => boolean;
  }[] = [];

  await Bun.$`mkdir -p ${directory}/src`;
  await Bun.write(apiEntrypoint, "export const handler = () => undefined;\n");
  await Bun.write(
    workerEntrypoint,
    "export const handler = () => undefined;\n"
  );
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index";
import { aws, sqsQueue } from "${import.meta.dir}/../../aws/src/index";

export default defineConfig({
  name: "dev-api",
  provider: aws(),
  stage: "local",
  region: "sa-east-1",
  entrypoint: "${apiEntrypoint}",
  cloudFormation: {
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

  await runCli(["dev", "--config", configPath], {
    run: (command, options) => {
      calls.push({
        command,
        env: options?.env,
        stdoutFilter: options?.stdoutFilter,
      });
    },
  });
  await runCli(["dev", workerEntrypoint, "--config", configPath], {
    run: (command, options) => {
      calls.push({
        command,
        env: options?.env,
        stdoutFilter: options?.stdoutFilter,
      });
    },
  });

  expect(calls.map((call) => call.command)).toEqual([
    ["bun", "--hot", apiEntrypoint],
    ["bun", "--hot", workerEntrypoint],
  ]);
  expect(calls[0]?.env).toMatchObject({
    AWS_REGION: "sa-east-1",
    LOG_LEVEL: "info",
    VOKE_DEV_ORIGIN: "http://localhost:3000",
    VOKE_DEV_STARTED_AT: expect.any(String),
    VOKE_DEV_SUMMARY: "1",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_RESOURCE_JOBS_QUEUE_URL:
      "http://localhost:4566/000000000000/JobsQueue",
    VOKE_STAGE: "local",
  });
  expect(calls[1]?.env).toMatchObject({
    AWS_REGION: "sa-east-1",
    LOG_LEVEL: "info",
    VOKE_DEV_ORIGIN: "http://localhost:3000",
    VOKE_DEV_STARTED_AT: expect.any(String),
    VOKE_RESOURCE_JOBS_QUEUE_URL:
      "http://localhost:4566/000000000000/JobsQueue",
  });
  expect(
    calls[0]?.stdoutFilter?.(
      "Started development server: http://localhost:3000"
    )
  ).toBe(false);
  expect(calls[0]?.stdoutFilter?.("  ➜  Local:   http://localhost:3000/")).toBe(
    true
  );
});

test("dev CLI lets hostname and port override the route summary origin", async () => {
  const directory = `/private/tmp/voke-dev-origin-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;
  const entrypoint = `${directory}/src/api.ts`;
  const calls: { command: string[]; env?: Record<string, string> }[] = [];

  await Bun.$`mkdir -p ${directory}/src`;
  await Bun.write(entrypoint, "export const handler = () => undefined;\n");
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index";

export default defineConfig({
  name: "dev-origin-api",
  entrypoint: "${entrypoint}",
});
`
  );

  await runCli(
    ["dev", "--hostname", "0.0.0.0", "--port", "4000", "--config", configPath],
    {
      run: (command, options) => {
        calls.push({ command, env: options?.env });
      },
    }
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.env).toMatchObject({
    VOKE_DEV_ORIGIN: "http://0.0.0.0:4000",
    VOKE_DEV_STARTED_AT: expect.any(String),
  });
});
