import { afterAll, expect, test } from "bun:test";

import { createFunctions, voke } from "voke";
import type { StandardSchemaV1 } from "voke";

import { durable } from "../src/index";
import { teardownDurableTests } from "../src/testing";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

afterAll(async () => {
  await teardownDurableTests();
});

test("without setupDurableTests a local durable run starts its own environment and waits in real time", async () => {
  const functions = createFunctions({
    remind: durable({
      executionTimeout: { minutes: 1 },
      handler: async (_payload, context) => {
        await context.durable.wait("pause", { seconds: 1 });

        return "reminded";
      },
      output: schema<string>(),
    }),
  });

  voke(functions, { config: { name: "shop" } });

  const started = Bun.nanoseconds();

  await expect(functions.invoke("remind")).resolves.toBe("reminded");
  expect((Bun.nanoseconds() - started) / 1e6).toBeGreaterThanOrEqual(900);
});
