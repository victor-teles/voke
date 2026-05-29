import { expect, test } from "bun:test";

import { sqs } from "@voke/aws";
import type { SqsMessageBatchIncludeInvalid } from "@voke/aws";
import { response } from "@voke/http";
import { schema } from "@voke/schema";

import { createFunctions, fn, http, route, voke } from "../src/index";
import type { Middleware } from "../src/index";
import type { StandardSchemaV1 } from "../src/invoke";

const standardSchema = <TInput, TOutput = TInput>(
  validate: (value: TInput) => TOutput
): StandardSchemaV1<TInput, TOutput> => ({
  "~standard": {
    validate: (value) => ({ data: validate(value), success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const userInput = standardSchema<unknown, { id: string }>((value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return { id: value.id };
  }

  throw new Error("id is required");
});

const userOutput = standardSchema<unknown, { id: string; name: string }>(
  (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      "name" in value &&
      typeof value.name === "string"
    ) {
      return { id: value.id, name: value.name };
    }

    throw new Error("user result is invalid");
  }
);

test("creates an invokable Function Registry and Gateway with the new public API", async () => {
  const functions = createFunctions({
    getUser: fn({
      handler: (payload, context) => ({
        id: payload.id,
        name: context.functionName,
      }),
      input: userInput,
      name: "read-user",
      output: userOutput,
    }),
  });

  const gateway = voke(functions, { config: { name: "users-api" } });

  expect(gateway.functions).toBe(functions);
  expect(Object.keys(functions)).toEqual(["getUser"]);
  expect(Object.isFrozen(functions)).toBe(true);
  expect(Object.isFrozen(functions.getUser)).toBe(true);

  await expect(functions.invoke("getUser", { id: "usr_1" })).resolves.toEqual({
    id: "usr_1",
    name: "read-user",
  });
});

test("rejects reserved Function Registry keys", () => {
  expect(() =>
    createFunctions({
      invoke: fn({
        handler: () => ({ ok: true }),
        output: standardSchema<unknown, { ok: boolean }>(() => ({ ok: true })),
      }),
    })
  ).toThrow('Function Registry key "invoke" is reserved');
});

test("auto-loads voke.config.ts when composing a Gateway", async () => {
  const previousPwd = Bun.env.PWD;
  const directory = "/private/tmp/voke-autoload-config-test";
  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    `${directory}/voke.config.ts`,
    'export default { name: "autoload-api", stage: "test" };'
  );
  Bun.env.PWD = directory;

  try {
    const functions = createFunctions({
      ping: fn({
        handler: () => ({ ok: true }),
        output: standardSchema<unknown, { ok: boolean }>(() => ({
          ok: true,
        })),
      }),
    });
    const gateway = voke(functions);

    expect(gateway.config.name).toBe("autoload-api");
    expect(gateway.config.stage).toBe("test");
    await expect(functions.invoke("ping")).resolves.toEqual({ ok: true });
  } finally {
    Bun.env.PWD = previousPwd;
  }
});

test("fails clearly when voke.config.ts cannot be auto-loaded", async () => {
  const previousPwd = Bun.env.PWD;
  const directory = "/private/tmp/voke-missing-config-test";
  await Bun.$`mkdir -p ${directory}`;
  Bun.env.PWD = directory;

  try {
    const functions = createFunctions({
      ping: fn({
        handler: () => ({ ok: true }),
        output: standardSchema<unknown, { ok: boolean }>(() => ({
          ok: true,
        })),
      }),
    });

    expect(() => voke(functions)).toThrow(
      `Voke config file not found: ${directory}/voke.config.ts`
    );
  } finally {
    Bun.env.PWD = previousPwd;
  }
});

test("keeps Function Registry activation idempotent within one Gateway context", async () => {
  const functions = createFunctions({
    ping: fn({
      handler: () => ({ ok: true }),
      output: standardSchema<unknown, { ok: boolean }>(() => ({
        ok: true,
      })),
    }),
  });

  voke(functions, { config: { name: "users-api" } });
  voke(functions, { config: { name: "users-api" } });

  expect(() => voke(functions, { config: { name: "different-api" } })).toThrow(
    "Function Registry is already activated"
  );
  await expect(functions.invoke("ping")).resolves.toEqual({ ok: true });
});

test("serves route-backed Functions through route, http, and Gateway request", async () => {
  const functions = createFunctions({
    http: http({
      routes: route.get("/users/:id", {
        handler: (req) => ({
          header: req.headers.get("x-request-id"),
          id: req.params.id,
          query:
            req.query instanceof URLSearchParams
              ? req.query.get("includePosts")
              : req.query.includePosts,
          raw: req.raw instanceof Request,
        }),
      }),
    }),
  });
  const gateway = voke(functions, { config: { name: "users-api" } });

  await expect(
    functions.route("GET", "/users/:id", {
      headers: new Headers({ "x-request-id": "req_1" }),
      params: { id: "usr_1" },
      query: new URLSearchParams({ includePosts: "true" }),
    })
  ).resolves.toEqual({
    header: "req_1",
    id: "usr_1",
    query: "true",
    raw: true,
  });

  const gatewayResponse = await gateway.request(
    "/users/usr_2?includePosts=false",
    {
      headers: { "x-request-id": "req_2" },
    }
  );

  expect(gatewayResponse.status).toBe(200);
  await expect(gatewayResponse.json()).resolves.toEqual({
    data: {
      header: "req_2",
      id: "usr_2",
      query: "false",
      raw: true,
    },
  });
});

test("exposes response helpers with data and error envelopes", async () => {
  await expect(response.ok({ ok: true }).json()).resolves.toEqual({
    data: { ok: true },
  });
  expect(response.created({ id: "usr_1" }).status).toBe(201);
  expect(response.noContent().status).toBe(204);

  await expect(
    response
      .error("Invalid request", {
        details: { requestId: "req_1" },
        issues: [{ message: "Required", path: ["body", "name"] }],
      })
      .json()
  ).resolves.toEqual({
    error: {
      details: { requestId: "req_1" },
      issues: [{ message: "Required", path: ["body", "name"] }],
      message: "Invalid request",
    },
  });
});

test("returns route validation issues with the public error envelope", async () => {
  const invalidBodySchema: StandardSchemaV1<unknown, { name: string }> = {
    "~standard": {
      validate: () => ({
        issues: [{ message: "Expected string", path: ["name"] }],
        success: false,
      }),
      vendor: "voke-test",
      version: 1,
    },
  };
  const functions = createFunctions({
    http: http({
      routes: route.post("/users", {
        body: invalidBodySchema,
        handler: (req) => ({ name: req.body?.name ?? "" }),
      }),
    }),
  });
  const gateway = voke(functions, { config: { name: "users-api" } });

  const invalidResponse = await gateway.request("/users", {
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  expect(invalidResponse.status).toBe(400);
  await expect(invalidResponse.json()).resolves.toEqual({
    error: {
      issues: [{ message: "Expected string", path: ["body", "name"] }],
      message: "Invalid body",
    },
  });
});

test("validates contracts with the minimal Voke schema helper", async () => {
  const userPayload = schema.object({
    id: schema.string().min(1),
    includePosts: schema.optional(schema.boolean()),
  });
  const userResult = schema.object({
    id: schema.string(),
    name: schema.string(),
  });
  const functions = createFunctions({
    getUser: fn({
      handler: (payload) => ({
        id: payload.id,
        name: payload.includePosts === true ? "Victor with posts" : "Victor",
      }),
      input: userPayload,
      output: userResult,
    }),
  });
  voke(functions, { config: { name: "users-api" } });

  await expect(
    functions.invoke("getUser", { id: "usr_1", includePosts: true })
  ).resolves.toEqual({ id: "usr_1", name: "Victor with posts" });
  await expect(functions.invoke("getUser", { id: "" })).rejects.toMatchObject({
    issues: [
      { message: "Expected string length to be at least 1", path: ["id"] },
    ],
  });
});

test("supports the minimal Voke schema helper surface", () => {
  const payload = schema.object({
    active: schema.boolean(),
    age: schema.coerce.number().int().min(18).max(99),
    kind: schema.enum(["admin", "user"]),
    marker: schema.literal("profile"),
    metadata: schema.null(),
    tags: schema.array(schema.string().max(10)),
    unset: schema.optional(schema.undefined()),
  });

  expect(
    payload["~standard"].validate({
      active: true,
      age: "42",
      kind: "admin",
      marker: "profile",
      metadata: null,
      tags: ["typescript"],
    })
  ).toEqual({
    data: {
      active: true,
      age: 42,
      kind: "admin",
      marker: "profile",
      metadata: null,
      tags: ["typescript"],
    },
    success: true,
  });

  expect(
    payload["~standard"].validate({
      active: true,
      age: "17",
      extra: true,
      kind: "owner",
      marker: "profile",
      metadata: null,
      tags: ["typescript"],
    })
  ).toMatchObject({
    issues: [
      { message: "Unexpected property", path: ["extra"] },
      { message: "Expected number to be at least 18", path: ["age"] },
      { message: 'Expected one of "admin", "user"', path: ["kind"] },
    ],
    success: false,
  });
});

test("uses Voke schema metadata to reject mismatched route param keys", () => {
  const functions = createFunctions({
    http: http({
      routes: route.get("/users/:id", {
        handler: (req) => ({ id: req.params.userId }),
        params: schema.object({
          userId: schema.string(),
        }),
      }),
    }),
  });

  expect(() => voke(functions, { config: { name: "users-api" } })).toThrow(
    'Route GET /users/:id params schema expects "userId", but path defines "id"'
  );
});

test("runs Gateway, scoped route, and per-route middleware in order", async () => {
  const calls: string[] = [];
  const gatewayMiddleware: Middleware = async (_context, next) => {
    calls.push("gateway:before");
    await next();
    calls.push("gateway:after");
  };
  const scopedMiddleware: Middleware = async (_context, next) => {
    calls.push("scoped:before");
    await next();
    calls.push("scoped:after");
  };
  const perRouteMiddleware: Middleware = async (_context, next) => {
    calls.push("route:before");
    await next();
    calls.push("route:after");
  };
  const authed = route.use(scopedMiddleware);
  const functions = createFunctions({
    http: http({
      routes: authed.get("/middleware", {
        handler: () => {
          calls.push("handler");
        },
        middleware: [perRouteMiddleware],
      }),
    }),
  });
  const gateway = voke(functions, {
    config: { name: "middleware-api" },
    middleware: [gatewayMiddleware],
  });

  const gatewayResponse = await gateway.request("/middleware");

  expect(gatewayResponse.status).toBe(204);
  expect(await gatewayResponse.text()).toBe("");
  expect(calls).toEqual([
    "gateway:before",
    "scoped:before",
    "route:before",
    "handler",
    "route:after",
    "scoped:after",
    "gateway:after",
  ]);
});

test("rejects GET and HEAD route body schemas", () => {
  expect(() =>
    route.get("/search", {
      body: schema.object({ q: schema.string() }),
      handler: () => ({ ok: true }),
    })
  ).toThrow("GET /search cannot define a body schema");
});

test("defines SQS Functions with single and multiple queue event sources", async () => {
  const handled: string[] = [];
  const orderMessage = schema.object({
    orderId: schema.string().min(1),
  });
  const functions = createFunctions({
    processOrder: sqs({
      batchSize: 5,
      handler: (batch, context) => {
        for (const message of batch.messages) {
          handled.push(`${context.functionName}:${message.body.orderId}`);
        }

        return batch.ok();
      },
      message: orderMessage,
      name: "process-order-worker",
      queue: "ordersQueue",
    }),
    reindexOrders: sqs({
      handler: (batch: SqsMessageBatchIncludeInvalid<{ orderId: string }>) => {
        for (const message of batch.messages) {
          if (message.valid) {
            handled.push(`reindex:${message.body.orderId}`);
          } else {
            handled.push(`invalid:${message.id}`);
          }
        }

        return batch.ok();
      },
      invalidMessageBody: "include",
      message: orderMessage,
      queues: [
        "ordersQueue",
        {
          batchSize: 1,
          enabled: false,
          maxBatchingWindowSeconds: 3,
          queue: "priorityQueue",
        },
      ],
    }),
  });

  expect(functions.processOrder.events).toEqual([
    {
      options: {
        batchSize: 5,
        enabled: undefined,
        maxBatchingWindowSeconds: undefined,
      },
      queue: "ordersQueue",
      source: "sqs",
    },
  ]);
  expect(functions.reindexOrders.events).toEqual([
    {
      options: {
        batchSize: 10,
        enabled: undefined,
        maxBatchingWindowSeconds: undefined,
      },
      queue: "ordersQueue",
      source: "sqs",
    },
    {
      options: { batchSize: 1, enabled: false, maxBatchingWindowSeconds: 3 },
      queue: "priorityQueue",
      source: "sqs",
    },
  ]);

  await expect(
    functions.sendEvent("processOrder", {
      messages: [{ body: { orderId: "ord_1" } }],
    })
  ).resolves.toEqual({ batchItemFailures: [] });
  await expect(
    (
      functions.invoke as (
        functionName: string,
        payload?: unknown
      ) => Promise<unknown>
    )("processOrder")
  ).rejects.toMatchObject({
    message: 'Function "processOrder" cannot be invoked with functions.invoke',
  });
  await expect(
    functions.sendEvent("reindexOrders", {
      messages: [
        { body: { orderId: "ord_2" }, id: "valid" },
        { body: {}, id: "invalid" },
      ],
    })
  ).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: "invalid" }],
  });
  expect(handled).toEqual([
    "process-order-worker:ord_1",
    "reindex:ord_2",
    "invalid:invalid",
  ]);
});

test("requires exactly one SQS queue shape", () => {
  expect(() =>
    sqs({
      handler: (batch) => batch.ok(),
      message: schema.object({ id: schema.string() }),
      queue: "ordersQueue",
      queues: ["priorityQueue"],
    })
  ).toThrow("Pass either queue or queues to sqs(), not both");

  expect(() =>
    sqs({
      handler: (batch) => batch.ok(),
      message: schema.object({ id: schema.string() }),
    })
  ).toThrow("sqs() requires queue or queues");
});
