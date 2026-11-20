import { expect, test } from "bun:test";

import { voke } from "../src/app";
import { runCli } from "../src/cli";
import { defineConfig, loadVokeConfig } from "../src/config";
import { createDevPlan } from "../src/dev";
import {
  VokeConfigError,
  VokeError,
  VokeModelError,
  VokeResourceBindingError,
} from "../src/errors";
import { createFunctions, fn } from "../src/invoke";
import type { InvokeContext, StandardSchemaV1 } from "../src/invoke";
import { createInternalModel } from "../src/model";
import { createServerlessMigration } from "../src/serverless-migration";
import { withEnv } from "./support/env";
import { tempPath } from "./support/temp";

test("standardizes framework error types for public workflows", async () => {
  expect(() =>
    defineConfig({
      name: "runtime-api",
      runtime: {
        lambda: "python3.12",
      },
    } as unknown as Parameters<typeof defineConfig>[0])
  ).toThrow(VokeConfigError);

  expect(() =>
    createInternalModel({
      name: "bad-model-api",
      resources: {
        ordersTable: {
          actions: ["dynamodb:GetItem"],
          bindingAttribute: "",
          bindingValue: "ref",
          cloudFormationType: "AWS::DynamoDB::Table",
          outputName: "Name",
          policyResource: "getAttArn",
          properties: {},
        },
      },
    })
  ).toThrow(VokeModelError);

  const text: StandardSchemaV1<string, string> = {
    "~standard": {
      validate: (value) => ({ value: value as string }),
      vendor: "voke-test",
      version: 1,
    },
  };
  const unlinked = createFunctions({
    readOrders: fn({
      handler: (_payload: undefined, context: InvokeContext) =>
        context.resource("ordersTable"),
      output: text,
    }),
  });

  voke(unlinked, { config: { name: "unlinked-api" } });
  await expect(unlinked.invoke("readOrders")).rejects.toThrow(
    VokeResourceBindingError
  );

  const missing = tempPath(
    `voke-error-design-${crypto.randomUUID()}/src/api.ts`
  );
  await expect(
    createDevPlan({
      entrypoint: missing,
      name: "missing-api",
    })
  ).rejects.toThrow(VokeConfigError);
});

test("explains bad config and model input with actionable details", () => {
  expect(() =>
    defineConfig({
      name: "runtime-api",
      runtime: {
        timeout: -1,
      },
    })
  ).toThrow(
    "Invalid Voke config at runtime.timeout: expected a positive integer number of seconds; received -1"
  );

  try {
    createInternalModel({
      name: "bad-model-api",
      resources: {
        ordersTable: {
          actions: ["dynamodb:GetItem"],
          bindingAttribute: "",
          bindingValue: "ref",
          cloudFormationType: "AWS::DynamoDB::Table",
          outputName: "Name",
          policyResource: "getAttArn",
          properties: {},
        },
      },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(VokeModelError);
    expect(error).toBeInstanceOf(VokeError);
    expect((error as VokeModelError).issues).toEqual([
      {
        message: "resource binding attribute must be a non-empty string.",
        path: "resources.ordersTable.binding.attribute",
      },
    ]);
    expect((error as VokeModelError).message).toBe(
      "Invalid Voke model at resources.ordersTable.binding.attribute: resource binding attribute must be a non-empty string."
    );
  }
});

test("prints CLI usage failures with the command and fix", async () => {
  await expect(runCli(["build", "--entrypoint"])).rejects.toThrow(
    "Invalid CLI usage: Missing value for --entrypoint\nUsage: voke build [entrypoint] [outdir]"
  );

  await expect(runCli(["unknown"])).rejects.toThrow(
    "Invalid CLI usage: Unknown command: unknown\nRun `voke --help` to see available commands."
  );
});

test("makes migration unsupported-feature messages specific and searchable", () => {
  const migration = createServerlessMigration({
    source: `
service: orders
provider:
  name: aws
functions:
  worker:
    handler: src/worker.handler
    events:
      - kafka:
          topic: orders
plugins:
  - serverless-custom-unknown
`,
  });

  expect(migration.report.unsupported).toContain(
    "Unsupported Serverless plugin serverless-custom-unknown: behavior is unknown to Voke. Review the plugin documentation, then migrate any generated resources, hooks, or packaging behavior manually."
  );
  expect(migration.report.unsupported).toContain(
    "Unsupported Serverless event kafka on function worker: kafka is not an automatic Voke migration target. Recreate the trigger, permissions, batching, and failure behavior manually before cutting over."
  );
});

const reject = (input: Record<string, unknown>) => () =>
  defineConfig({ name: "removed", ...input } as Parameters<
    typeof defineConfig
  >[0]);

test("rejects the removed config-first and single-function settings with a path", () => {
  expect(reject({ functions: {} })).toThrow(VokeConfigError);
  expect(reject({ functions: {} })).toThrow(
    "Invalid Voke config at functions: Functions are declared in the project entrypoint, not in voke.config.ts"
  );
  expect(reject({ handler: "index.handler" })).toThrow(
    'Invalid Voke config at handler: "handler" was removed'
  );
  expect(reject({ cloudFormation: { handler: "index.handler" } })).toThrow(
    "Invalid Voke config at cloudFormation.handler"
  );
  expect(reject({ api: { routes: ["$default"] } })).toThrow(
    "Invalid Voke config at api.routes"
  );
  expect(reject({ api: { function: "api" } })).toThrow(
    "Invalid Voke config at api.function"
  );
});

test("rejects nested cloudFormation resources and environment with the top-level replacement", () => {
  expect(reject({ cloudFormation: { resources: {} } })).toThrow(
    'Invalid Voke config at cloudFormation.resources: "cloudFormation.resources" was removed; declare resources at the top level: resources: { ... }'
  );
  expect(reject({ cloudFormation: { environment: {} } })).toThrow(
    'Invalid Voke config at cloudFormation.environment: "cloudFormation.environment" was removed; declare environment at the top level: environment: { ... }'
  );
  expect(
    defineConfig({
      cloudFormation: { out: "./stack.json" },
      environment: { LOG_LEVEL: "info" },
      name: "top-level",
      resources: {},
    })
  ).toMatchObject({
    cloudFormation: { out: "./stack.json" },
    environment: { LOG_LEVEL: "info" },
    resources: {},
  });
});

test("reads the stage from VOKE_STAGE only", async () => {
  await withEnv({ STAGE: "prod", VOKE_STAGE: undefined }, () => {
    expect(defineConfig({ name: "stage" }).stage).toBe("local");
  });
  await withEnv({ STAGE: undefined, VOKE_STAGE: "prod" }, () => {
    expect(defineConfig({ name: "stage" }).stage).toBe("prod");
  });
});

test("requires a default export from voke.config.ts", async () => {
  const directory = tempPath(`voke-named-config-${crypto.randomUUID()}`);
  const configPath = `${directory}/voke.config.ts`;

  await Bun.write(
    configPath,
    'export const config = { name: "named-export" };\n'
  );

  await expect(loadVokeConfig({ path: configPath })).rejects.toThrow(
    `Voke config must export a default config from ${configPath}`
  );
});

test("rejects runtime.lambda with the AWS provider replacement", () => {
  expect(reject({ runtime: { lambda: "nodejs24.x" } })).toThrow(
    'Invalid Voke config at runtime.lambda: "runtime.lambda" moved to the AWS provider; use aws({ lambda: { runtime } })'
  );
});

test("defaults Function timeout and memory and rejects non-positive values", () => {
  expect(defineConfig({ name: "defaults" }).runtime).toEqual({
    memory: 1024,
    timeout: 15,
  });
  expect(reject({ runtime: { memory: 0 } })).toThrow(
    "Invalid Voke config at runtime.memory: expected a positive integer number of MB; received 0"
  );
  expect(reject({ runtime: { timeout: 1.5 } })).toThrow(
    "Invalid Voke config at runtime.timeout: expected a positive integer number of seconds; received 1.5"
  );
});

test("normalizes api.cors and rejects credentials with a wildcard origin", () => {
  expect(defineConfig({ name: "no-cors" }).api.cors).toBeUndefined();
  expect(
    defineConfig({ api: { cors: false }, name: "off" }).api.cors
  ).toBeUndefined();
  expect(defineConfig({ api: { cors: true }, name: "open" }).api.cors).toEqual({
    credentials: false,
    headers: ["*"],
    methods: ["*"],
    origins: ["*"],
  });
  expect(
    defineConfig({
      api: {
        cors: {
          credentials: true,
          maxAgeSeconds: 600,
          origins: ["https://app.example"],
        },
      },
      name: "partial",
    }).api.cors
  ).toEqual({
    credentials: true,
    headers: ["*"],
    maxAgeSeconds: 600,
    methods: ["*"],
    origins: ["https://app.example"],
  });
  expect(reject({ api: { cors: { credentials: true } } })).toThrow(
    'Invalid Voke config at api.cors.credentials: expected explicit origins when credentials is true; received ["*"]. List explicit origins: api.cors.origins'
  );
  expect(reject({ api: { cors: { origins: [] } } })).toThrow(
    "Invalid Voke config at api.cors.origins: expected at least one origin; received []"
  );
});
