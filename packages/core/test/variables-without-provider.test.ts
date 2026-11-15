import { expect, test } from "bun:test";

import {
  createFunctions,
  createVariableSource,
  fn,
  voke,
  VokeRuntimeVariableError,
} from "../src/index";
import type { StandardSchemaV1 } from "../src/index";
import { withEnv } from "./support/env";

const text: StandardSchemaV1<string, string> = {
  "~standard": {
    validate: (value) =>
      typeof value === "string"
        ? { value }
        : { issues: [{ message: "expected string" }] },
    vendor: "voke-test",
    version: 1,
  },
};

// A descriptor for a provider id that nothing registers, as an AWS Runtime Variable is when no
// Provider is configured (core tests, @voke/testing clients).
const createRegistry = () =>
  createFunctions({
    readKey: fn({
      handler: async (_payload, context) =>
        await context.variables.apiKey.text(),
      output: text,
      variables: {
        apiKey: createVariableSource("aws", {
          kind: "secretsManagerSecret",
          secretId: "prod/api-key",
        }),
      },
    }),
  });

test("a Gateway without a Provider resolves Runtime Variables from overrides", async () => {
  const functions = createRegistry();
  voke(functions, {
    config: { name: "no-provider-overrides" },
    variables: { overrides: { defaults: { apiKey: "from-override" } } },
  });

  await expect(functions.invoke("readKey")).resolves.toBe("from-override");
});

test("a Gateway without a Provider resolves Runtime Variables from the environment", async () => {
  const functions = createRegistry();
  voke(functions, { config: { name: "no-provider-environment" } });

  await withEnv({ VOKE_VARIABLE_API_KEY: "from-environment" }, async () => {
    await expect(functions.invoke("readKey")).resolves.toBe("from-environment");
  });
});

test("a Gateway without a Provider fails at load when no value is available", async () => {
  const functions = createRegistry();
  voke(functions, { config: { name: "no-provider-missing" } });

  await expect(functions.invoke("readKey")).rejects.toThrow(
    VokeRuntimeVariableError
  );
  await expect(functions.invoke("readKey")).rejects.toThrow(
    'Runtime variable "apiKey" for Function "readKey" references provider "aws", but no Runtime Variable provider with that id is registered.'
  );
});
