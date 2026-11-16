import { expect, spyOn, test } from "bun:test";

import { voke } from "../src/app";
import type { VokeConfigInput, VokeResourceInput } from "../src/config";
import { VokeResourceBindingError } from "../src/errors";
import {
  activateFunctionRegistry,
  createFunctions,
  fn,
  http,
} from "../src/invoke";
import type {
  AnyFunctionDefinition,
  EventFunctionDefinition,
  InvokeContext,
  InvokeOptions,
  StandardSchemaV1,
} from "../src/invoke";
import type { VokeProvider } from "../src/provider";
import { route } from "../src/route-builder";
import { withEnv } from "./support/env";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value }),
    vendor: "voke-test",
    version: 1,
  },
});

// A hand-written resource, so these tests need no Provider package.
const table: VokeResourceInput = {
  actions: ["dynamodb:GetItem"],
  bindingAttribute: "name",
  bindingValue: "ref",
  cloudFormationType: "AWS::DynamoDB::Table",
  outputName: "Name",
  policyResource: "getAttArn",
  properties: {},
};

const bindingName = "VOKE_RESOURCE_USERS_TABLE_NAME";

const config = (overrides: Partial<VokeConfigInput> = {}): VokeConfigInput => ({
  name: "links",
  resources: { usersTable: table },
  ...overrides,
});

const notLinkedMessage = (functionKey: string): string =>
  `Function "${functionKey}" does not link resource "usersTable". Add it to the Function: resources: ["usersTable"]`;

const readUsersTable = (_payload: undefined, context: InvokeContext): string =>
  context.resource("usersTable");

const withBinding = async <TResult>(
  value: string | undefined,
  run: () => Promise<TResult>
): Promise<TResult> => await withEnv({ [bindingName]: value }, run);

test("a Function reads a resource it links through context.resource", async () => {
  const functions = createFunctions({
    listUsers: fn({
      handler: readUsersTable,
      output: schema<string>(),
      resources: ["usersTable"],
    }),
  });

  voke(functions, { config: config() });

  await withBinding("users-table-dev", async () => {
    await expect(functions.invoke("listUsers")).resolves.toBe(
      "users-table-dev"
    );
  });
});

test("functions.invoke rejects a read of a resource the Function does not link", async () => {
  const functions = createFunctions({
    listUsers: fn({ handler: readUsersTable, output: schema<string>() }),
  });

  voke(functions, { config: config() });

  await withBinding("users-table-dev", async () => {
    const rejection = functions.invoke("listUsers");

    await expect(rejection).rejects.toBeInstanceOf(VokeResourceBindingError);
    await expect(rejection).rejects.toThrow(notLinkedMessage("listUsers"));
  });
});

test("a route rejects a read of a resource its Function does not link", async () => {
  const functions = createFunctions({
    users: http({
      routes: [
        route.get("/users", {
          handler: (_request, context) => context.resource("usersTable"),
        }),
      ],
    }),
  });
  const gateway = voke(functions, { config: config() });
  const logged = spyOn(console, "error").mockImplementation(() => {});

  try {
    await withBinding("users-table-dev", async () => {
      await expect(functions.route("GET", "/users")).rejects.toThrow(
        new VokeResourceBindingError(notLinkedMessage("users"))
      );

      const response = await gateway.request("/users");

      expect(response.status).toBe(500);
      expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
        code: "RESOURCE_BINDING_ERROR",
        message: notLinkedMessage("users"),
      });
    });
  } finally {
    logged.mockRestore();
  }
});

test("functions.sendEvent rejects a read of a resource the Function does not link", async () => {
  const tick: EventFunctionDefinition<
    string,
    StandardSchemaV1<{ ticks: number }>
  > = {
    events: [{ properties: {}, source: "custom" }],
    handler: (_event, context) => context.resource("usersTable"),
    input: schema<{ ticks: number }>(),
    key: "",
    kind: "event",
  };
  const functions = createFunctions({ tick });

  voke(functions, { config: config() });

  await withBinding("users-table-dev", async () => {
    const rejection = functions.sendEvent("tick", { ticks: 1 });

    await expect(rejection).rejects.toBeInstanceOf(VokeResourceBindingError);
    await expect(rejection).rejects.toThrow(notLinkedMessage("tick"));
  });
});

test("a Request Authorizer Function rejects a read of a resource it does not link", async () => {
  const authorizeSession = {
    handler: (_request: unknown, context: InvokeContext) => ({
      authorized: context.resource("usersTable") !== "",
    }),
    key: "",
    kind: "authorizer",
    routes: [],
  } as unknown as AnyFunctionDefinition;
  const functions = createFunctions({
    authorizeSession,
    users: http({
      authorizer: "session",
      authorizers: {
        session: {
          cacheTtlSeconds: 0,
          function: "authorizeSession",
          identitySource: ["$request.header.authorization"],
          kind: "lambda",
        },
      },
      resources: ["usersTable"],
      routes: [route.get("/me", { handler: () => ({ ok: true }) })],
    }),
  });
  const gateway = voke(functions, { config: config() });

  await withBinding("users-table-dev", async () => {
    const response = await gateway.request("/me", {
      headers: { authorization: "Bearer token" },
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toContain(
      'Function \\"authorizeSession\\" does not link resource \\"usersTable\\"'
    );
  });
});

test("a linked read rejects when the binding variable is unset", async () => {
  const functions = createFunctions({
    listUsers: fn({
      handler: readUsersTable,
      output: schema<string>(),
      resources: ["usersTable"],
    }),
  });

  voke(functions, { config: config() });

  await withBinding(undefined, async () => {
    const rejection = functions.invoke("listUsers");

    await expect(rejection).rejects.toBeInstanceOf(VokeResourceBindingError);
    await expect(rejection).rejects.toThrow(
      `Missing resource binding: ${bindingName}`
    );
  });
});

interface InnerInvoker {
  invoke: (
    key: "inner",
    payload?: undefined,
    options?: InvokeOptions
  ) => Promise<unknown>;
}

// `outer` calls `inner` in-process; `inner` links usersTable and reads it.
const nestedRegistry = (outerResources: readonly string[]) => {
  const caller: { registry?: InnerInvoker } = {};
  const registry = createFunctions({
    inner: fn({
      handler: readUsersTable,
      output: schema<string>(),
      resources: ["usersTable"],
    }),
    outer: fn({
      handler: async () => String(await caller.registry?.invoke("inner")),
      output: schema<string>(),
      resources: outerResources,
    }),
  });

  caller.registry = registry;

  return registry;
};

test("an in-process invocation reads only what the entry Function links", async () => {
  const registry = nestedRegistry([]);

  voke(registry, { config: config() });

  await withBinding("users-table-dev", async () => {
    const rejection = registry.invoke("outer");

    await expect(rejection).rejects.toBeInstanceOf(VokeResourceBindingError);
    await expect(rejection).rejects.toThrow(
      'Function "inner" reads resource "usersTable" while running in-process inside Function "outer", which does not link it. An in-process invocation runs with the caller\'s role: add resources: ["usersTable"] to "outer"'
    );
  });
});

test("an in-process invocation reads a resource both Functions link", async () => {
  const registry = nestedRegistry(["usersTable"]);

  voke(registry, { config: config() });

  await withBinding("users-table-dev", async () => {
    await expect(registry.invoke("outer")).resolves.toBe("users-table-dev");
  });
});

test("a read rejects when the registry was activated without a config", async () => {
  const functions = createFunctions({
    listUsers: fn({
      handler: readUsersTable,
      output: schema<string>(),
      resources: ["usersTable"],
    }),
  });

  activateFunctionRegistry(functions, "test");

  await withBinding("users-table-dev", async () => {
    const rejection = functions.invoke("listUsers");

    await expect(rejection).rejects.toBeInstanceOf(VokeResourceBindingError);
    await expect(rejection).rejects.toThrow(
      'Function "listUsers" reads resource "usersTable", but its Function Registry was activated without a config, so Voke cannot resolve the binding. Create the Gateway with the config: voke(functions, { config })'
    );
  });
});

test("an invocation the Provider routes through its transport starts a new entry Function", async () => {
  const registry = nestedRegistry([]);
  // The transport stands in for another Lambda: it runs inner's handler in this process, but as
  // its own entry, the way the deployed Function would run with its own role.
  const provider: VokeProvider = {
    invoke: {
      target: ({ key }) =>
        key === "inner" ? { functionName: "remote-inner" } : undefined,
      transport: () => ({
        invoke: async () => ({
          payload: await registry.invoke("inner", undefined, {
            runtime: "local",
          }),
          statusCode: 200,
        }),
      }),
    },
    name: "fake",
  };

  voke(registry, { config: config({ provider }) });

  await withBinding("users-table-dev", async () => {
    await expect(registry.invoke("outer")).resolves.toBe("users-table-dev");
  });
});
