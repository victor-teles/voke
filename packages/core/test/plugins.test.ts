import { expect, spyOn, test } from "bun:test";

import {
  createAuthorizers,
  lambdaAuthorizer,
  requestAuthorizer,
} from "@voke/aws";
import { sqsQueue } from "@voke/aws/cloudformation";

import { voke } from "../src/app";
import { defineConfig } from "../src/config";
import type { VokeConfigInput } from "../src/config";
import { VokeConfigError } from "../src/errors";
import { createFunctions, fn, http } from "../src/invoke";
import type {
  EventFunctionDefinition,
  InvokeError,
  StandardSchemaV1,
} from "../src/invoke";
import { createInternalModel } from "../src/model";
import { projectFunctionEntries } from "../src/plugin";
import type { FunctionExecution, VokePlugin } from "../src/plugin";
import { route } from "../src/route-builder";
import { withEnv } from "./support/env";

const schema = <TValue>(
  check: (value: unknown) => boolean = () => true
): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) =>
      check(value)
        ? { value: value as TValue }
        : { issues: [{ message: "invalid" }] },
    vendor: "voke-test",
    version: 1,
  },
});

const configIssues = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(VokeConfigError);

    return (error as VokeConfigError & { issues?: unknown }).issues;
  }

  throw new Error("expected a VokeConfigError");
};

const recordingPlugin = (name: string, calls: string[]): VokePlugin => ({
  name,
  runtime: {
    setup: () => ({
      wrap: async (execution, next) => {
        calls.push(`${name}:before:${execution.kind}:${execution.functionKey}`);
        const result = await next();
        calls.push(`${name}:after`);

        return result;
      },
    }),
  },
});

const pingPlugin = (): VokePlugin => ({
  contributions: {
    functions: {
      ping: http({
        routes: [
          route.get("/plugin-ping", { handler: () => ({ pong: true }) }),
        ],
      }),
    },
  },
  name: "probe",
});

// Step 1: config

test("a config with Plugins normalizes them in declaration order", () => {
  const first = pingPlugin();
  const second: VokePlugin = { name: "second" };
  const config = defineConfig({ name: "orders", plugins: [first, second] });

  expect(config.plugins).toEqual([first, second]);
  expect(defineConfig({ name: "orders" }).plugins).toEqual([]);
});

test("Plugin resources and environment join the config's own", () => {
  const queue = sqsQueue();
  const plugin: VokePlugin = {
    contributions: {
      environment: { AUDIT_LEVEL: "full" },
      resources: { auditQueue: queue },
    },
    name: "audit",
  };
  const config = defineConfig({
    environment: { LOG_LEVEL: "debug" },
    name: "orders",
    plugins: [plugin],
  });

  expect(config.environment).toEqual({
    AUDIT_LEVEL: "full",
    LOG_LEVEL: "debug",
  });
  expect(config.resources.auditQueue).toBe(queue);
});

test("normalizing a normalized config with Plugins gives the same config", () => {
  const input: VokeConfigInput = {
    environment: { LOG_LEVEL: "debug" },
    name: "orders",
    plugins: [
      {
        contributions: {
          environment: { AUDIT_LEVEL: "full" },
          resources: { auditQueue: sqsQueue() },
        },
        name: "audit",
      },
    ],
  };

  expect(defineConfig(defineConfig(input))).toEqual(defineConfig(input));
});

test("invalid Plugins fail with a config error at a documented path", () => {
  expect(
    configIssues(() =>
      defineConfig({ name: "orders", plugins: [{ name: "Open API" }] })
    )
  ).toEqual([
    {
      message:
        'expected a Plugin name matching ^[a-z][a-z0-9-]*$; received "Open API"',
      path: "plugins.0.name",
    },
  ]);
  expect(
    configIssues(() =>
      defineConfig({
        name: "orders",
        plugins: [{ name: "audit" }, { name: "audit" }],
      })
    )
  ).toEqual([
    {
      message: 'expected unique Plugin names; received "audit" more than once',
      path: "plugins.1.name",
    },
  ]);
  expect(
    configIssues(() =>
      defineConfig({
        name: "orders",
        plugins: [{ cli: { commands: {}, description: "x" }, name: "deploy" }],
      })
    )
  ).toEqual([
    {
      message:
        'expected a Plugin name that is not a built-in command when the Plugin declares cli; received "deploy"',
      path: "plugins.0.name",
    },
  ]);
});

test("a Plugin with a built-in command name is valid when it declares no cli", () => {
  expect(
    defineConfig({ name: "orders", plugins: [{ name: "deploy" }] }).plugins
  ).toHaveLength(1);
});

test("Plugin Functions must be route-backed and well named", () => {
  const invokable = fn({ handler: () => "ok", output: schema<string>() });

  expect(
    configIssues(() =>
      defineConfig({
        name: "orders",
        plugins: [
          {
            contributions: {
              functions: {
                "Bad.Name": http({ routes: [] }),
                job: invokable as never,
              },
            },
            name: "tools",
          },
        ],
      })
    )
  ).toEqual([
    {
      message:
        'expected a Function name matching ^[a-z][A-Za-z0-9]*$; received "Bad.Name"',
      path: "plugins.tools.contributions.functions.Bad.Name",
    },
    {
      message:
        'expected a route-backed Function from http(); received "invokable". Plugins contribute route-backed Functions only in v1',
      path: "plugins.tools.contributions.functions.job.kind",
    },
  ]);
});

test("Plugin contributions that collide with the project's are config errors", () => {
  expect(
    configIssues(() =>
      defineConfig({
        environment: { LOG_LEVEL: "debug" },
        name: "orders",
        plugins: [
          {
            contributions: {
              environment: { LOG_LEVEL: "trace" },
              resources: { ordersQueue: sqsQueue() },
            },
            name: "audit",
          },
        ],
        resources: { ordersQueue: sqsQueue() },
      })
    )
  ).toEqual([
    {
      message:
        'expected a environment variable key the project and other Plugins do not use; received "LOG_LEVEL"',
      path: "plugins.audit.contributions.environment.LOG_LEVEL",
    },
  ]);
  expect(
    configIssues(() =>
      defineConfig({
        name: "orders",
        plugins: [
          {
            contributions: { resources: { ordersQueue: sqsQueue() } },
            name: "audit",
          },
        ],
        resources: { ordersQueue: sqsQueue() },
      })
    )
  ).toEqual([
    {
      message:
        'expected a resource key the project and other Plugins do not use; received "ordersQueue"',
      path: "plugins.audit.contributions.resources.ordersQueue",
    },
  ]);
});

// Step 2: Function Wraps

test("a Plugin wrap runs around an invokable handler with its parsed payload", async () => {
  const executions: FunctionExecution[] = [];
  const functions = createFunctions({
    greet: fn({
      handler: (payload: { name: string }) => `Hello ${payload.name}`,
      input: schema<{ name: string }>(),
      output: schema<string>(),
    }),
  });

  voke(functions, {
    config: {
      name: "wrap-invokable",
      plugins: [
        {
          name: "observe",
          runtime: {
            setup: () => ({
              wrap: async (execution, next) => {
                executions.push(execution);

                return await next();
              },
            }),
          },
        },
      ],
    },
  });

  await expect(functions.invoke("greet", { name: "Ada" })).resolves.toBe(
    "Hello Ada"
  );
  expect(executions).toHaveLength(1);
  expect(executions[0]?.kind).toBe("invokable");
  expect(executions[0]?.functionKey).toBe("greet");
  expect(executions[0]?.input).toEqual({ name: "Ada" });
  expect(executions[0]?.context.functionName).toBe("greet");
});

test("two Plugins wrap in declaration order, the first outermost", async () => {
  const calls: string[] = [];
  const functions = createFunctions({
    greet: fn({
      handler: () => {
        calls.push("handler");

        return "hi";
      },
      output: schema<string>(),
    }),
  });

  voke(functions, {
    config: {
      name: "wrap-order",
      plugins: [
        recordingPlugin("outer", calls),
        recordingPlugin("inner", calls),
      ],
    },
  });

  await functions.invoke("greet");

  expect(calls).toEqual([
    "outer:before:invokable:greet",
    "inner:before:invokable:greet",
    "handler",
    "inner:after",
    "outer:after",
  ]);
});

test("a wrap runs around route handlers through gateway.request and functions.route", async () => {
  const executions: FunctionExecution[] = [];
  const functions = createFunctions({
    users: http({
      routes: [
        route.get("/users/:id", {
          handler: (request) => ({ id: request.params.id }),
        }),
      ],
    }),
  });
  const gateway = voke(functions, {
    config: {
      name: "wrap-route",
      plugins: [
        {
          name: "observe",
          runtime: {
            setup: () => ({
              wrap: async (execution, next) => {
                executions.push(execution);

                return await next();
              },
            }),
          },
        },
      ],
    },
  });

  const response = await gateway.request("/users/42");

  expect(await response.json()).toEqual({ data: { id: "42" } });
  await expect(
    functions.route("GET", "/users/:id", { params: { id: "7" } })
  ).resolves.toEqual({ id: "7" });
  expect(executions.map((execution) => execution.kind)).toEqual([
    "route",
    "route",
  ]);
  expect(executions[0]?.route).toBe("GET /users/:id");
  expect(executions[0]?.functionKey).toBe("users");
  const routeInput = executions[0]?.input as { params: unknown } | undefined;

  expect(routeInput?.params).toEqual({ id: "42" });
});

test("a wrap runs around an Event Invocation", async () => {
  const calls: string[] = [];
  const tick: EventFunctionDefinition<
    string,
    StandardSchemaV1<{ ticks: number }>,
    Record<never, never>,
    { done: boolean }
  > = {
    events: [{ properties: {}, source: "custom" }],
    handler: (event) => ({ done: event.ticks > 0 }),
    input: schema<{ ticks: number }>(),
    key: "",
    kind: "event",
  };
  const functions = createFunctions({ tick });

  voke(functions, {
    config: {
      name: "wrap-event",
      plugins: [recordingPlugin("observe", calls)],
    },
  });

  await expect(functions.sendEvent("tick", { ticks: 1 })).resolves.toEqual({
    done: true,
  });
  expect(calls).toEqual(["observe:before:event:tick", "observe:after"]);
});

test("a wrap runs around a Request Authorizer Function", async () => {
  const calls: string[] = [];
  const functions = createFunctions({
    authorizeSession: requestAuthorizer({
      handler: () => ({ authorized: true, context: { userId: "u1" } }),
    }),
    users: http({
      authorizer: "session",
      authorizers: createAuthorizers({
        session: lambdaAuthorizer({ function: "authorizeSession" }),
      }),
      routes: [route.get("/me", { handler: (request) => request.auth })],
    }),
  });
  const gateway = voke(functions, {
    config: { name: "wrap-auth", plugins: [recordingPlugin("observe", calls)] },
  });

  const response = await gateway.request("/me", {
    headers: { authorization: "Bearer token" },
  });

  expect(response.status).toBe(200);
  expect(calls).toEqual([
    "observe:before:authorizer:authorizeSession",
    "observe:after",
    "observe:before:route:users",
    "observe:after",
  ]);
});

test("a short-circuiting wrap returns its value, still validated against the output schema", async () => {
  let handlerCalls = 0;
  const functions = createFunctions({
    count: fn({
      handler: () => {
        handlerCalls += 1;

        return 1;
      },
      output: schema<number>((value) => typeof value === "number"),
    }),
  });

  voke(functions, {
    config: {
      name: "wrap-short-circuit",
      plugins: [
        {
          name: "cache",
          runtime: { setup: () => ({ wrap: () => Promise.resolve(42) }) },
        },
      ],
    },
  });

  await expect(functions.invoke("count")).resolves.toBe(42);
  expect(handlerCalls).toBe(0);

  const invalid = createFunctions({
    count: fn({
      handler: () => 1,
      output: schema<number>((value) => typeof value === "number"),
    }),
  });

  voke(invalid, {
    config: {
      name: "wrap-short-circuit-invalid",
      plugins: [
        {
          name: "cache",
          runtime: { setup: () => ({ wrap: () => Promise.resolve("cached") }) },
        },
      ],
    },
  });

  const failure = (await invalid
    .invoke("count")
    .catch((error: unknown) => error)) as InvokeError | undefined;

  expect(failure?.code).toBe("INVALID_RESULT");
});

test("calling next() twice rejects with an error that names the Plugin", async () => {
  let handlerCalls = 0;
  const functions = createFunctions({
    count: fn({
      handler: () => {
        handlerCalls += 1;

        return 1;
      },
      output: schema<number>(),
    }),
  });

  voke(functions, {
    config: {
      name: "wrap-twice",
      plugins: [
        {
          name: "retry",
          runtime: {
            setup: () => ({
              wrap: async (_execution, next) => {
                await next();

                return await next();
              },
            }),
          },
        },
      ],
    },
  });

  await expect(functions.invoke("count")).rejects.toThrow(
    'Plugin "retry" called next() more than once for Function "count"'
  );
  expect(handlerCalls).toBe(1);
});

const frames = (stack: string | undefined): string[] =>
  (stack ?? "").split("\n").filter((line) => line.trim().startsWith("at "));

test("a registry without Plugin wraps calls the handler directly", async () => {
  const stacks: string[] = [];
  const handler = () => {
    stacks.push(new Error("probe").stack ?? "");

    return "ok";
  };
  const plain = createFunctions({
    probe: fn({ handler, output: schema<string>() }),
  });
  const wrapped = createFunctions({
    probe: fn({ handler, output: schema<string>() }),
  });

  voke(plain, { config: { name: "no-wraps", plugins: [{ name: "inert" }] } });
  voke(wrapped, {
    config: {
      name: "with-wraps",
      plugins: [recordingPlugin("observe", [])],
    },
  });

  await plain.invoke("probe");
  await wrapped.invoke("probe");

  // The wrapped call adds the wrap and its dispatch frames between handler and runLocalFunction;
  // the plain call has none of them.
  const plainFrames = frames(stacks[0]);
  const wrappedFrames = frames(stacks[1]);

  expect(
    plainFrames.filter((line) => line.includes("plugins.test.ts"))
  ).toHaveLength(2);
  expect(
    wrappedFrames.filter((line) => line.includes("plugins.test.ts"))
  ).toHaveLength(3);
  expect(wrappedFrames.length).toBeGreaterThanOrEqual(plainFrames.length + 4);
});

// Step 3: Plugin Functions and the Gateway

test("a Plugin-contributed route answers through the Gateway", async () => {
  const functions = createFunctions({
    http: http({ routes: [route.get("/", { handler: () => "home" })] }),
  });
  const gateway = voke(functions, {
    config: { name: "plugin-route", plugins: [pingPlugin()] },
  });

  const response = await gateway.request("/plugin-ping");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { pong: true } });
  expect(gateway.functions).toBe(functions);
  expect(Object.isFrozen(functions)).toBe(true);
  expect(Object.keys(functions)).toEqual(["http"]);
});

test("Plugin wraps cover Plugin Functions too", async () => {
  const calls: string[] = [];
  const gateway = voke(
    createFunctions({
      http: http({ routes: [route.get("/", { handler: () => "home" })] }),
    }),
    {
      config: {
        name: "plugin-route-wrap",
        plugins: [pingPlugin(), recordingPlugin("observe", calls)],
      },
    }
  );

  await gateway.request("/plugin-ping");

  expect(calls).toEqual(["observe:before:route:probe-ping", "observe:after"]);
});

test("a Plugin route that duplicates a project route fails like two project routes", () => {
  const functions = createFunctions({
    http: http({
      routes: [route.get("/plugin-ping", { handler: () => "mine" })],
    }),
  });

  expect(() =>
    voke(functions, { config: { name: "dupe", plugins: [pingPlugin()] } })
  ).toThrow(
    'Duplicate Gateway route GET /plugin-ping in functions "http" and "probe-ping".'
  );
});

test("a project Function key equal to a Plugin Function key is a config error", () => {
  const functions = createFunctions({
    "probe-ping": http({ routes: [route.get("/", { handler: () => "x" })] }),
  });

  expect(
    configIssues(() =>
      voke(functions, { config: { name: "clash", plugins: [pingPlugin()] } })
    )
  ).toEqual([
    {
      message:
        'expected a Function key that Function "ping" of Plugin "probe" does not use; received "probe-ping". Rename the Function in the project entrypoint',
      path: "functions.probe-ping",
    },
  ]);
});

test("Plugin middleware runs after CORS and before the Gateway's own middleware", async () => {
  const order: string[] = [];
  const gateway = voke(
    createFunctions({
      http: http({ routes: [route.get("/", { handler: () => "home" })] }),
    }),
    {
      config: {
        api: { cors: true },
        name: "plugin-middleware",
        plugins: [
          {
            name: "first",
            runtime: {
              setup: () => ({
                middleware: [
                  async (c, next) => {
                    order.push(
                      `first:${c.res.headers.get("access-control-allow-origin") ?? "pending"}`
                    );
                    await next();
                  },
                ],
              }),
            },
          },
          {
            name: "second",
            runtime: {
              setup: () => ({
                middleware: [
                  async (_c, next) => {
                    order.push("second");
                    await next();
                  },
                ],
              }),
            },
          },
        ],
      },
      middleware: [
        async (_c, next) => {
          order.push("gateway");
          await next();
        },
      ],
    }
  );

  const response = await gateway.request("/", {
    headers: { origin: "https://example.com" },
  });

  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(order).toEqual(["first:*", "second", "gateway"]);
});

const homeFunctions = () =>
  createFunctions({
    http: http({ routes: [route.get("/", { handler: () => "home" })] }),
  });

test("runtime.setup receives the config, the dev flag and every Gateway Function", async () => {
  const seen: { dev: boolean; keys: string[]; name: string }[] = [];
  const plugin: VokePlugin = {
    ...pingPlugin(),
    runtime: {
      setup: ({ config, dev, functions }) => {
        seen.push({
          dev,
          keys: functions.map(([key]) => key),
          name: config.name,
        });
      },
    },
  };

  voke(homeFunctions(), { config: { name: "setup", plugins: [plugin] } });
  await withEnv({ VOKE_DEV_SUMMARY: "1" }, () => {
    const info = spyOn(console, "info").mockImplementation(() => {});

    try {
      voke(homeFunctions(), {
        config: { name: "setup-dev", plugins: [plugin] },
      });
    } finally {
      info.mockRestore();
    }
  });

  expect(seen).toEqual([
    { dev: false, keys: ["http", "probe-ping"], name: "setup" },
    { dev: true, keys: ["http", "probe-ping"], name: "setup-dev" },
  ]);
});

test("the Dev Function Summary lists Plugin Functions with their prefixed key", async () => {
  const lines: string[] = [];

  await withEnv({ VOKE_DEV_SUMMARY: "1" }, () => {
    const info = spyOn(console, "info").mockImplementation((line: string) => {
      lines.push(line);
    });

    try {
      voke(
        createFunctions({
          http: http({ routes: [route.get("/", { handler: () => "home" })] }),
        }),
        { config: { name: "summary", plugins: [pingPlugin()] } }
      );
    } finally {
      info.mockRestore();
    }
  });

  const summary = lines.join("\n");

  expect(summary).toContain("probe-ping");
  expect(summary).toContain("/plugin-ping");
});

// Step 4: model and project entries

test("projectFunctionEntries lists the project's Functions, then the Plugin's, and is idempotent", () => {
  const plugin = pingPlugin();
  const functions = createFunctions({
    http: http({ routes: [route.get("/", { handler: () => "home" })] }),
  });
  const config = defineConfig({ name: "entries", plugins: [plugin] });
  const entries = projectFunctionEntries(functions, config);

  expect(entries.map(([key]) => key)).toEqual(["http", "probe-ping"]);
  expect(entries[1]?.[1].key).toBe("probe-ping");
  expect(Object.isFrozen(entries[1]?.[1])).toBe(true);
  expect(projectFunctionEntries(functions, config)[1]?.[1]).toBe(
    entries[1]?.[1]
  );
  expect(
    projectFunctionEntries(Object.fromEntries(entries), config).map(
      ([key]) => key
    )
  ).toEqual(["http", "probe-ping"]);
});

test("the model deploys Plugin Functions, routes, resources and Provider records", () => {
  const record = {
    properties: {
      statements: [{ actions: ["s3:GetObject"], resources: ["*"] }],
    },
    type: "iam.policy",
  };
  const queue = sqsQueue();
  const model = createInternalModel({
    functions: createFunctions({
      http: http({ routes: [route.get("/", { handler: () => "home" })] }),
    }),
    name: "shop",
    plugins: [
      {
        ...pingPlugin(),
        contributions: {
          ...pingPlugin().contributions,
          provider: { aws: record },
          resources: { auditQueue: queue },
        },
      },
    ],
    stage: "dev",
  });

  expect(model.apis.http?.routes).toContainEqual({
    function: "probe-ping",
    route: "GET /plugin-ping",
  });
  expect(model.functions["probe-ping"]?.deployedName).toBe(
    "shop-dev-probe-ping"
  );
  expect(model.functions["probe-ping"]?.handler).toBe("index.probePing");
  expect(model.resources.auditQueue).toBeDefined();
  expect(model.plugins).toEqual({ probe: { provider: { aws: record } } });
  expect(model.plugins?.probe?.provider.aws).toBe(record);
  expect(model.schemaVersion).toBe("1");
});

test("a model without Plugin Provider records has no plugins field", () => {
  const model = createInternalModel({
    name: "shop",
    plugins: [pingPlugin()],
  });

  expect("plugins" in model).toBe(false);
});
