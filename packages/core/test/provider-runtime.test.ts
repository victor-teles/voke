import { expect, test } from "bun:test";

import { voke } from "../src/app";
import { defineFunctions, defineFunction } from "../src/invoke";
import type { StandardSchemaV1 } from "../src/invoke";
import type { VokeProvider } from "../src/provider";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

test("extends a Gateway through a configured Provider runtime capability", () => {
  const provider: VokeProvider<{ deployTarget: string }> = {
    name: "test-provider",
    runtime: {
      gateway: ({ config }) => ({
        deployTarget: `${config.name}:${config.stage}`,
      }),
    },
  };
  const functions = defineFunctions({
    ping: defineFunction({
      handler: () => ({ ok: true }),
      output: schema<{ ok: boolean }>(),
    }),
  });

  const gateway = voke(functions, {
    config: { name: "orders", stage: "dev" },
    provider,
  }) as ReturnType<typeof voke<typeof functions>> & { deployTarget: string };

  expect(gateway.deployTarget).toBe("orders:dev");
  expect("handler" in gateway).toBe(false);
});
