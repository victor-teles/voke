import { expect, test } from "bun:test";

import { bindResource } from "../src/aws";
import { runCli } from "../src/cli";
import { defineConfig } from "../src/config";
import { createDevPlan } from "../src/dev";
import {
  VokeConfigError,
  VokeError,
  VokeModelError,
  VokeResourceBindingError,
} from "../src/errors";
import { createInternalModel } from "../src/model";
import { createServerlessMigration } from "../src/serverless-migration";

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
      cloudFormation: {
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
      },
      name: "bad-model-api",
    })
  ).toThrow(VokeModelError);

  const missingBinding = bindResource("ordersTable", "name");
  expect(() => missingBinding.value()).toThrow(VokeResourceBindingError);

  const missing = `/private/tmp/voke-error-design-${crypto.randomUUID()}/src/api.ts`;
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
        lambda: "python3.12",
      },
    } as unknown as Parameters<typeof defineConfig>[0])
  ).toThrow(
    'Invalid Voke config at runtime.lambda: expected one of "nodejs22.x", "nodejs24.x"; received "python3.12"'
  );

  try {
    createInternalModel({
      cloudFormation: {
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
      },
      name: "bad-model-api",
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
