import { afterAll, beforeAll, expect, test } from "bun:test";

import { createFunctions, voke } from "voke";
import type { FunctionExecution, StandardSchemaV1, VokePlugin } from "voke";

import { durable } from "../src/index";
import { setupDurableTests, teardownDurableTests } from "../src/testing";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

beforeAll(async () => {
  await setupDurableTests();
});

afterAll(async () => {
  await teardownDurableTests();
});

// Plan 019 relies on plan 018 running a Durable Function through functions.invoke, so a Plugin
// wrap covers it with no durable-specific code.
test("a Plugin wrap runs around a Durable Function execution", async () => {
  const seen: Pick<FunctionExecution, "functionKey" | "input" | "kind">[] = [];
  const results: unknown[] = [];
  const recorder: VokePlugin = {
    name: "recorder",
    runtime: {
      setup: () => ({
        wrap: async (execution, next) => {
          seen.push({
            functionKey: execution.functionKey,
            input: execution.input,
            kind: execution.kind,
          });
          const result = await next();
          results.push(result);

          return result;
        },
      }),
    },
  };
  const functions = createFunctions({
    countItems: durable({
      executionTimeout: { minutes: 5 },
      handler: async (order, context) => {
        const total = await context.durable.step(
          "count",
          async () => await Promise.resolve(order.items.length)
        );

        return { total };
      },
      input: schema<{ items: string[] }>(),
      output: schema<{ total: number }>(),
    }),
  });

  voke(functions, { config: { name: "durable-plugins", plugins: [recorder] } });

  await expect(
    functions.invoke("countItems", { items: ["a", "b"] })
  ).resolves.toEqual({ total: 2 });
  expect(seen[0]).toEqual({
    functionKey: "countItems",
    input: { items: ["a", "b"] },
    kind: "invokable",
  });
  expect(results.at(-1)).toEqual({ total: 2 });
});
