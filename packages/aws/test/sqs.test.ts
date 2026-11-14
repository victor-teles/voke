import { expect, test } from "bun:test";

import { createFunctions, voke, VokeConfigError } from "voke";
import type { StandardSchemaV1 } from "voke";

import { secret, sqs } from "../src/index";

const order: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    validate: (value) => ({ data: value as { id: string }, success: true }),
    vendor: "voke-test",
    version: 1,
  },
};

test("sqs() reports queue misuse as a VokeConfigError", () => {
  expect(() =>
    sqs({
      handler: (batch) => batch.ok(),
      message: order,
      queue: "orders",
      queues: ["refunds"],
    })
  ).toThrow(VokeConfigError);
  expect(() => sqs({ message: order } as never)).toThrow(VokeConfigError);
});

test("sqs() Functions read Runtime Variables from their handler context", async () => {
  const seen: string[] = [];
  const functions = createFunctions({
    processOrder: sqs({
      handler: async (batch, context) => {
        seen.push(await context.variables.signingKey.text());

        return batch.ok();
      },
      message: order,
      queue: "orders",
      variables: { signingKey: secret("prod/signing-key") },
    }),
  });
  voke(functions, {
    config: { name: "sqs-variables" },
    variables: { overrides: { defaults: { signingKey: "test-key" } } },
  });

  await expect(
    functions.sendEvent("processOrder", {
      messages: [{ body: { id: "ord_1" }, id: "m1" }],
    })
  ).resolves.toEqual({ batchItemFailures: [] });
  expect(seen).toEqual(["test-key"]);
});
