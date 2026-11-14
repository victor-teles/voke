import { expect, test } from "bun:test";

import type { StandardSchemaV1 } from "../src/invoke";
import {
  createRuntimeVariables,
  createVariableProvider,
  createVariableSource,
  VokeRuntimeVariableError,
} from "../src/variables";

const objectSchema: StandardSchemaV1<unknown, { enabled: boolean }> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "enabled" in value &&
      typeof value.enabled === "boolean"
        ? { data: { enabled: value.enabled }, success: true }
        : { issues: [{ message: "enabled is required" }], success: false },
    vendor: "voke-test",
    version: 1,
  },
};

test("creates frozen Runtime Variable descriptors and providers", async () => {
  const provider = createVariableProvider({
    id: "test",
    load: () => ({ status: "found", value: "secret-value" }),
  });
  const source = createVariableSource("test", {
    id: "api-key",
    kind: "secret",
  });

  expect(Object.isFrozen(provider)).toBe(true);
  expect(Object.isFrozen(source)).toBe(true);
  expect(Object.isFrozen(source.source)).toBe(true);

  const variables = createRuntimeVariables({
    functionKey: "checkout",
    providers: [provider],
    variables: { apiKey: source },
  });

  await expect(variables.apiKey.text()).resolves.toBe("secret-value");
});

test("rejects duplicate Runtime Variable provider ids", () => {
  const provider = createVariableProvider({
    id: "test",
    load: () => ({ status: "missing" }),
  });

  expect(() =>
    createRuntimeVariables({
      functionKey: "checkout",
      providers: [provider, provider],
      variables: {},
    })
  ).toThrow('Runtime Variable provider "test" is registered more than once.');
});

test("rejects malformed and unknown Runtime Variable providers early", () => {
  expect(() =>
    createVariableProvider({ id: "", load: () => ({ status: "missing" }) })
  ).toThrow("Runtime Variable provider id must not be empty.");
  expect(() =>
    createVariableProvider({ id: "test", load: undefined } as never)
  ).toThrow('Runtime Variable provider "test" must define a load function.');

  expect(() =>
    createRuntimeVariables({
      functionKey: "checkout",
      providers: [],
      variables: {
        apiKey: createVariableSource("test", {
          id: "api-key",
          kind: "secret",
        }),
      },
    })
  ).toThrow(
    'Runtime variable "apiKey" for Function "checkout" references provider "test", but no Runtime Variable provider with that id is registered.'
  );
});

test("throws a redacted Runtime Variable error for missing required values", async () => {
  const provider = createVariableProvider({
    id: "test",
    load: () => ({ status: "missing" }),
  });
  const variables = createRuntimeVariables({
    functionKey: "checkout",
    providers: [provider],
    variables: {
      apiKey: createVariableSource("test", { id: "api-key", kind: "secret" }),
    },
  });

  await expect(variables.apiKey.text()).rejects.toThrow(
    VokeRuntimeVariableError
  );
  await expect(variables.apiKey.text()).rejects.toThrow(
    'Runtime variable "apiKey" for Function "checkout" could not be resolved from test secret "api-key".'
  );
});

test("resolves Runtime Variables from overrides and environment before provider loading", async () => {
  const calls: string[] = [];
  const provider = createVariableProvider({
    id: "test",
    load: ({ variableKey }) => {
      calls.push(variableKey);

      return { status: "found", value: `provider:${variableKey}` };
    },
  });
  const descriptor = createVariableSource("test", {
    id: "api-key",
    kind: "secret",
  });
  const env = {
    VOKE_VARIABLE_API_KEY: "env:default",
    VOKE_VARIABLE_CHECKOUT_ENV_ONLY: "env:function",
  };
  const variables = createRuntimeVariables({
    env,
    functionKey: "checkout",
    overrides: {
      defaults: { apiKey: "override:default" },
      functions: {
        checkout: { apiKey: "override:function" },
      },
    },
    providers: [provider],
    variables: {
      apiKey: descriptor,
      envOnly: descriptor,
      providerOnly: descriptor,
    },
  });

  await expect(variables.apiKey.text()).resolves.toBe("override:function");
  await expect(variables.envOnly.text()).resolves.toBe("env:function");
  await expect(variables.providerOnly.text()).resolves.toBe(
    "provider:providerOnly"
  );
  expect(calls).toEqual(["providerOnly"]);
});

test("rejects non-string Runtime Variable override values", () => {
  const provider = createVariableProvider({
    id: "test",
    load: () => ({ status: "missing" }),
  });

  expect(() =>
    createRuntimeVariables({
      functionKey: "checkout",
      overrides: {
        defaults: { apiKey: 123 } as never,
      },
      providers: [provider],
      variables: {
        apiKey: createVariableSource("test", {
          id: "api-key",
          kind: "secret",
        }),
      },
    })
  ).toThrow('Runtime Variable override "apiKey" must be a string.');
});

test("supports optional Runtime Variables and JSON parsing", async () => {
  const provider = createVariableProvider({
    id: "test",
    load: ({ variableKey }) =>
      variableKey === "missing"
        ? { status: "missing" }
        : { status: "found", value: '{"enabled":true}' },
  });
  const variables = createRuntimeVariables({
    functionKey: "checkout",
    providers: [provider],
    variables: {
      flags: createVariableSource("test", { id: "flags", kind: "secret" }),
      missing: createVariableSource(
        "test",
        { id: "missing", kind: "secret" },
        { optional: true }
      ),
    },
  });

  await expect(variables.flags.json()).resolves.toEqual({ enabled: true });
  await expect(variables.flags.json(objectSchema)).resolves.toEqual({
    enabled: true,
  });
  await expect(variables.missing.text()).resolves.toBeUndefined();
  await expect(variables.missing.json()).resolves.toBeUndefined();
});

test("throws redacted Runtime Variable errors for invalid JSON and provider failures", async () => {
  const providerFailure = new Error("provider exploded with secret-value");
  const provider = createVariableProvider({
    id: "test",
    load: ({ variableKey }) => {
      if (variableKey === "broken") {
        throw providerFailure;
      }

      return { status: "found", value: "not json" };
    },
  });
  const variables = createRuntimeVariables({
    functionKey: "checkout",
    providers: [provider],
    variables: {
      broken: createVariableSource(
        "test",
        { id: "broken", kind: "secret" },
        { optional: true }
      ),
      flags: createVariableSource("test", { id: "flags", kind: "secret" }),
    },
  });

  await expect(variables.flags.json()).rejects.toThrow(
    'Runtime variable "flags" for Function "checkout" is not valid JSON.'
  );

  try {
    await variables.broken.text();
    throw new Error("Expected Runtime Variable failure");
  } catch (error) {
    expect(error).toBeInstanceOf(VokeRuntimeVariableError);
    expect((error as Error).message).not.toContain("secret-value");
    expect((error as Error).cause).toBe(providerFailure);
  }
});

test("passes abort signals to providers and rejects non-string found values", async () => {
  const { signal } = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const provider = createVariableProvider({
    id: "test",
    load: (context) => {
      receivedSignal = context.signal;

      return { status: "found", value: 123 } as never;
    },
  });
  const variables = createRuntimeVariables({
    functionKey: "checkout",
    providers: [provider],
    signal,
    variables: {
      apiKey: createVariableSource("test", { id: "api-key", kind: "secret" }),
    },
  });

  await expect(variables.apiKey.text()).rejects.toThrow(
    'Runtime variable "apiKey" for Function "checkout" provider "test" returned a non-string value.'
  );
  expect(receivedSignal).toBe(signal);
});

test("caches raw Runtime Variable values and refreshes through the full resolver", async () => {
  const calls: string[] = [];
  const provider = createVariableProvider({
    id: "test",
    load: ({ variableKey }) => {
      calls.push(variableKey);

      return { status: "found", value: `provider:${calls.length}` };
    },
  });
  const descriptor = createVariableSource("test", {
    id: "flags",
    kind: "secret",
  });
  const env: Record<string, string | undefined> = {
    VOKE_VARIABLE_FLAGS: '{"enabled":true}',
  };
  const variables = createRuntimeVariables({
    env,
    functionKey: "checkout",
    providers: [provider],
    variables: { flags: descriptor },
  });

  await expect(variables.flags.text()).resolves.toBe('{"enabled":true}');
  env.VOKE_VARIABLE_FLAGS = '{"enabled":false}';
  await expect(variables.flags.text()).resolves.toBe('{"enabled":true}');
  await expect(variables.flags.json()).resolves.toEqual({ enabled: true });
  await expect(variables.flags.json()).resolves.toEqual({ enabled: true });
  await expect(variables.flags.refresh()).resolves.toBe(variables.flags);
  await expect(variables.flags.text()).resolves.toBe('{"enabled":false}');
  Reflect.deleteProperty(env, "VOKE_VARIABLE_FLAGS");
  await expect(variables.flags.refresh()).resolves.toBe(variables.flags);
  await expect(variables.flags.text()).resolves.toBe("provider:1");
  await expect(variables.flags.text()).resolves.toBe("provider:1");
  expect(calls).toEqual(["flags"]);
});

test("supports cache policies, TTL, in-flight dedupe, and failed-load retries", async () => {
  let now = 1000;
  let attempts = 0;
  const loadGate = Promise.withResolvers<null>();
  let shouldGateUncached = true;
  const provider = createVariableProvider({
    id: "test",
    load: async ({ variableKey }) => {
      attempts += 1;

      if (variableKey === "failsOnce" && attempts === 1) {
        throw new Error("temporary provider failure");
      }

      if (variableKey === "uncached" && shouldGateUncached) {
        shouldGateUncached = false;
        await loadGate.promise;
      }

      return { status: "found", value: `${variableKey}:${attempts}` };
    },
  });
  const variables = createRuntimeVariables({
    clock: () => now,
    functionKey: "checkout",
    providers: [provider],
    variables: {
      failsOnce: createVariableSource("test", {
        id: "fails-once",
        kind: "secret",
      }),
      ttl: createVariableSource(
        "test",
        { id: "ttl", kind: "secret" },
        { cache: { ttlSeconds: 5 } }
      ),
      uncached: createVariableSource(
        "test",
        {
          id: "uncached",
          kind: "secret",
        },
        { cache: false }
      ),
    },
  });

  await expect(variables.failsOnce.text()).rejects.toThrow(
    VokeRuntimeVariableError
  );
  await expect(variables.failsOnce.text()).resolves.toBe("failsOnce:2");

  await expect(variables.ttl.text()).resolves.toBe("ttl:3");
  now += 4000;
  await expect(variables.ttl.text()).resolves.toBe("ttl:3");
  now += 1001;
  await expect(variables.ttl.text()).resolves.toBe("ttl:4");

  const firstUncached = variables.uncached.text();
  const secondUncached = variables.uncached.text();
  loadGate.resolve(null);
  await expect(firstUncached).resolves.toBe("uncached:5");
  await expect(secondUncached).resolves.toBe("uncached:5");
  await expect(variables.uncached.text()).resolves.toBe("uncached:6");
});
