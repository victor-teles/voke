import { expect, test } from "bun:test";

import type { MiddlewareHandler } from "hono";

import { createGateway } from "../src/app";
import {
  createAuthorizers,
  lambdaAuthorizer,
  requestAuthorizer,
} from "../src/authorizers";
import { secret } from "../src/aws";
import type { VokeEnv } from "../src/context";
import { VokeConfigError } from "../src/errors";
import {
  defineFunction,
  defineFunctions,
  http,
  sqsEventSource,
  sqsMessageBatch,
} from "../src/invoke";
import type { InvokeError, StandardSchemaV1 } from "../src/invoke";
import { Voke } from "../src/route-builder";
import { createVariableProvider, createVariableSource } from "../src/variables";

const schema = <TInput, TOutput = TInput>(
  validate: (value: TInput) => TOutput
): StandardSchemaV1<TInput, TOutput> => ({
  "~standard": {
    validate: (value) => ({ data: validate(value), success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const failingSchema = (message: string): StandardSchemaV1<unknown, never> => ({
  "~standard": {
    validate: () => ({ issues: [{ message }], success: false }),
    vendor: "voke-test",
    version: 1,
  },
});

const restoreEnv = (name: string, value?: string): void => {
  Bun.env[name] = value;
};

const ansi = {
  bold: "\u001B[1m",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  reset: "\u001B[0m",
} as const;

test("executes route-backed functions through typed route calls and gateway requests", async () => {
  let middlewareCalls = 0;
  const middleware: MiddlewareHandler<VokeEnv> = async (c, next) => {
    middlewareCalls += 1;
    await next();
  };
  const app = new Voke().use(middleware);

  const functions = defineFunctions({
    users: defineFunction({
      routes: [
        app.get("/users/:id", {
          handler: (req) => ({
            body: req.body,
            header: req.headers["x-request-id"],
            id: req.params.id,
            includePosts: req.query.includePosts,
          }),
          headers: schema<Headers, { "x-request-id": string }>((headers) => ({
            "x-request-id": headers.get("x-request-id") ?? "",
          })),
          params: schema<{ id: string }, { id: string }>((params) => ({
            id: params.id ?? "",
          })),
          query: schema<Record<string, string>, { includePosts: boolean }>(
            (query) => ({
              includePosts: query.includePosts === "true",
            })
          ),
        }),
        app.post("/users/:id", {
          body: schema<unknown, { name: string }>((value) => {
            if (
              typeof value === "object" &&
              value !== null &&
              "name" in value &&
              typeof value.name === "string"
            ) {
              return { name: value.name };
            }

            return { name: "Anonymous" };
          }),
          handler: (req) =>
            new Response(`${req.params.id}:${req.body.name}`, { status: 201 }),
          params: schema<{ id: string }, { id: string }>((params) => ({
            id: params.id ?? "",
          })),
        }),
      ],
    }),
  });

  createGateway({ functions });

  const routeResult = await functions.route("GET", "/users/:id", {
    headers: new Headers({ "x-request-id": "req_1" }),
    params: { id: "usr_1" },
    query: { includePosts: "true" },
  });

  expect(routeResult).toEqual({
    body: undefined,
    header: "req_1",
    id: "usr_1",
    includePosts: true,
  });

  const gateway = createGateway({ functions });
  const getResponse = await gateway.request("/users/usr_2?includePosts=false", {
    headers: { "x-request-id": "req_2" },
  });

  expect(getResponse).toBeInstanceOf(Response);
  expect(await getResponse.json()).toEqual({
    data: {
      body: undefined,
      header: "req_2",
      id: "usr_2",
      includePosts: false,
    },
  });
  expect(middlewareCalls).toBe(1);

  const postResponse = await gateway.request("/users/usr_3", {
    body: JSON.stringify({ name: "Victor" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  expect(postResponse.status).toBe(201);
  expect(await postResponse.text()).toBe("usr_3:Victor");
});

test("runs local Request Authorizer Functions before protected routes", async () => {
  const app = new Voke();
  const provider = createVariableProvider({
    id: "test",
    load: () => ({ status: "found", value: "Bearer valid" }),
  });
  const authorizers = createAuthorizers({
    session: lambdaAuthorizer({ function: "authorizeSession" }),
  });
  const functions = defineFunctions({
    authorizeSession: requestAuthorizer({
      handler: async (request, context) => ({
        authorized:
          request.headers.get("authorization") ===
          (await context.variables.expectedToken.text()),
        context: { userId: "usr_1" },
      }),
      variables: {
        expectedToken: createVariableSource("test", {
          id: "expected-token",
          kind: "secret",
        }),
      },
    }),
    users: http({
      authorizer: "session",
      authorizers,
      routes: app.get("/me", {
        handler: (request) => ({
          userId: request.auth.context.userId,
        }),
      }),
    }),
  });
  const gateway = createGateway({
    functions,
    variables: { providers: [provider] },
  });

  const response = await gateway.request("/me", {
    headers: { authorization: "Bearer valid" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      userId: "usr_1",
    },
  });
});

test("supports injected Route Auth Context for direct route calls", async () => {
  const app = new Voke();
  const functions = defineFunctions({
    users: http({
      routes: app.get("/me", {
        handler: (request) => ({
          userId: request.auth.context.userId,
        }),
      }),
    }),
  });

  const result = await functions.route("GET", "/me", {
    auth: {
      context: { userId: "usr_2" },
      source: "lambda",
    },
  });

  expect(result).toEqual({ userId: "usr_2" });
});

test("returns stable local authorizer failures", async () => {
  const app = new Voke();
  const authorizers = createAuthorizers({
    session: lambdaAuthorizer({ function: "authorizeSession" }),
  });
  const functions = defineFunctions({
    authorizeSession: requestAuthorizer({
      handler: (request) => ({
        authorized: request.headers.get("authorization") === "Bearer valid",
      }),
    }),
    brokenAuthorizer: requestAuthorizer({
      handler: () => ({ context: { userId: "usr_1" } }) as never,
    }),
    invalidContextAuthorizer: requestAuthorizer({
      context: failingSchema("context is invalid"),
      handler: () => ({
        authorized: true,
        context: { userId: "usr_1" },
      }),
    }),
    users: http({
      authorizer: "session",
      authorizers: createAuthorizers({
        broken: lambdaAuthorizer({ function: "brokenAuthorizer" }),
        invalidContext: lambdaAuthorizer({
          function: "invalidContextAuthorizer",
        }),
        ...authorizers,
      }),
      routes: [
        app.get("/me", {
          handler: () => ({ ok: true }),
        }),
        app.get("/broken", {
          authorizer: "broken",
          handler: () => ({ ok: true }),
        }),
        app.get("/invalid-context", {
          authorizer: "invalidContext",
          handler: () => ({ ok: true }),
        }),
      ],
    }),
  });
  const gateway = createGateway({ functions });

  const missing = await gateway.request("/me");
  const denied = await gateway.request("/me", {
    headers: { authorization: "Bearer invalid" },
  });
  const broken = await gateway.request("/broken", {
    headers: { authorization: "Bearer valid" },
  });
  const invalidContext = await gateway.request("/invalid-context", {
    headers: { authorization: "Bearer valid" },
  });

  expect(missing.status).toBe(401);
  expect(await missing.json()).toMatchObject({
    error: { code: "UNAUTHORIZED" },
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({
    error: { code: "FORBIDDEN" },
  });
  expect(broken.status).toBe(500);
  expect(await broken.json()).toMatchObject({
    error: { code: "INTERNAL_SERVER_ERROR" },
  });
  expect(invalidContext.status).toBe(500);
  expect(await invalidContext.json()).toMatchObject({
    error: { code: "INTERNAL_SERVER_ERROR" },
  });
});

test("prints a human function summary automatically under voke dev", () => {
  const app = new Voke();
  const previousOrigin = Bun.env.VOKE_DEV_ORIGIN;
  const previousStartedAt = Bun.env.VOKE_DEV_STARTED_AT;
  const previousSummary = Bun.env.VOKE_DEV_SUMMARY;
  const previousInfo = console.info;
  const logs: string[] = [];

  Bun.env.VOKE_DEV_ORIGIN = "http://localhost:3000";
  Bun.env.VOKE_DEV_STARTED_AT = String(Date.now() + 1000);
  Bun.env.VOKE_DEV_SUMMARY = "1";
  console.info = (message?: unknown) => {
    logs.push(String(message));
  };

  try {
    const functions = defineFunctions({
      getUser: defineFunction({
        handler: () => ({ id: "usr_1" }),
        output: schema<unknown, { id: string }>(() => ({ id: "usr_1" })),
        variables: {
          userSecret: secret("/prod/users/secret"),
        },
      }),
      processOrders: defineFunction({
        events: [
          sqsEventSource("ordersQueue", {
            batchSize: 10,
            maxBatchingWindowSeconds: 5,
          }),
        ],
        handler: (batch) => batch.ok(),
        input: sqsMessageBatch(
          schema<unknown, { id: string }>(() => ({ id: "ord_1" }))
        ),
        variables: {
          orderSecret: secret("/prod/orders/secret"),
        },
      }),
      routes: defineFunction({
        routes: [
          app.get("/health", {
            handler: () => ({ ok: true }),
          }),
        ],
        variables: {
          routeSecret: secret("/prod/routes/secret"),
        },
      }),
    });

    createGateway({ functions });
  } finally {
    console.info = previousInfo;
    restoreEnv("VOKE_DEV_ORIGIN", previousOrigin);
    restoreEnv("VOKE_DEV_STARTED_AT", previousStartedAt);
    restoreEnv("VOKE_DEV_SUMMARY", previousSummary);
  }

  expect(logs.map((log) => log.trimEnd())).toEqual([
    `  ${ansi.cyan}${ansi.bold}VOKE${ansi.reset} ${ansi.dim}v0.0.0${ansi.reset}  ${ansi.green}ready in 0 ms${ansi.reset}

  ${ansi.green}➜${ansi.reset}  ${ansi.bold}Local:${ansi.reset}   http://localhost:3000/
  ${ansi.green}➜${ansi.reset}  ${ansi.bold}Network:${ansi.reset} use --hostname 0.0.0.0 to expose

${ansi.cyan}${ansi.bold}Route Functions${ansi.reset}
  ${ansi.bold}routes${ansi.reset}
    ${ansi.green}GET${ansi.reset} /health ${ansi.dim}->${ansi.reset} ${ansi.cyan}http://localhost:3000/health${ansi.reset}

${ansi.cyan}${ansi.bold}Invokable Functions${ansi.reset}
  ${ansi.bold}getUser${ansi.reset}
    ${ansi.dim}internal${ansi.reset}

${ansi.cyan}${ansi.bold}Event Functions${ansi.reset}
  ${ansi.bold}processOrders${ansi.reset}
    ${ansi.green}SQS${ansi.reset} ${ansi.bold}ordersQueue${ansi.reset} ${ansi.dim}batchSize=10 maxBatchingWindowSeconds=5 enabled=true${ansi.reset}`,
  ]);
  expect(logs.join("\n")).not.toContain("userSecret");
  expect(logs.join("\n")).not.toContain("orderSecret");
  expect(logs.join("\n")).not.toContain("routeSecret");
  expect(logs.join("\n")).not.toContain("/prod/");
});

test("returns a stable Voke error envelope when route body validation fails through gateway requests", async () => {
  const app = new Voke();
  const functions = defineFunctions({
    users: defineFunction({
      routes: [
        app.post("/users", {
          body: failingSchema("name is required"),
          handler: () => ({ ok: true }),
        }),
      ],
    }),
  });
  const gateway = createGateway({ functions });

  const response = await gateway.request("/users", {
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      issues: [{ message: "name is required", path: ["body"] }],
      message: "Invalid body",
    },
  });
});

test("returns stable Voke error envelopes when route params, query, or headers validation fails through gateway requests", async () => {
  const app = new Voke();
  const functions = defineFunctions({
    users: defineFunction({
      routes: [
        app.get("/params/:id", {
          handler: () => ({ ok: true }),
          params: failingSchema("id is invalid"),
        }),
        app.get("/query", {
          handler: () => ({ ok: true }),
          query: failingSchema("page is invalid"),
        }),
        app.get("/headers", {
          handler: () => ({ ok: true }),
          headers: failingSchema("authorization is required"),
        }),
      ],
    }),
  });
  const gateway = createGateway({ functions });

  const paramsResponse = await gateway.request("/params/usr_1");
  const queryResponse = await gateway.request("/query?page=nope");
  const headersResponse = await gateway.request("/headers");

  expect(paramsResponse.status).toBe(400);
  expect(await paramsResponse.json()).toEqual({
    error: {
      issues: [{ message: "id is invalid", path: ["params"] }],
      message: "Invalid params",
    },
  });
  expect(queryResponse.status).toBe(400);
  expect(await queryResponse.json()).toEqual({
    error: {
      issues: [{ message: "page is invalid", path: ["query"] }],
      message: "Invalid query",
    },
  });
  expect(headersResponse.status).toBe(400);
  expect(await headersResponse.json()).toEqual({
    error: {
      issues: [{ message: "authorization is required", path: ["headers"] }],
      message: "Invalid headers",
    },
  });
});

test("returns a stable Voke error envelope when route output validation fails through gateway requests", async () => {
  const app = new Voke();
  const functions = defineFunctions({
    users: defineFunction({
      routes: [
        app.get("/users/:id", {
          handler: () => ({ id: "" }),
          output: failingSchema("id is required"),
        }),
      ],
    }),
  });
  const gateway = createGateway({ functions });

  const response = await gateway.request("/users/usr_1");

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: {
      issues: [{ message: "id is required", path: ["result"] }],
      message: "Invalid result",
    },
  });
});

test("invokes routes without request parts when the route does not require them", async () => {
  const app = new Voke();
  const functions = defineFunctions({
    routes: defineFunction({
      routes: [
        app.get("/health", {
          handler: () => ({ ok: true }),
        }),
      ],
    }),
  });

  createGateway({ functions });

  await expect(functions.route("GET", "/health")).resolves.toEqual({
    ok: true,
  });
});

test("returns a stable Voke error envelope for missing gateway routes", async () => {
  const gateway = createGateway();

  const response = await gateway.request("/missing");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  });
});

test("uses the same route validation classification for typed route calls and gateway requests", async () => {
  const app = new Voke();
  const functions = defineFunctions({
    users: defineFunction({
      routes: [
        app.get("/users/:id", {
          handler: () => ({ ok: true }),
          params: failingSchema("id is invalid"),
        }),
      ],
    }),
  });
  const gateway = createGateway({ functions });

  await expect(
    functions.route("GET", "/users/:id", {
      params: { id: "usr_1" },
    })
  ).rejects.toMatchObject({
    code: "INVALID_PAYLOAD",
    functionName: "GET /users/:id",
    message: "Invalid params for GET /users/:id: id is invalid",
  } satisfies Partial<InvokeError>);

  const response = await gateway.request("/users/usr_1");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      issues: [{ message: "id is invalid", path: ["params"] }],
      message: "Invalid params",
    },
  });
});

test("rejects duplicate HTTP method and path pairs across gateway functions", () => {
  const app = new Voke();
  const functions = defineFunctions({
    admins: defineFunction({
      routes: [
        app.get("/users/:id", {
          handler: () => ({ from: "admins" }),
        }),
      ],
    }),
    users: defineFunction({
      routes: [
        app.get("/users/:id", {
          handler: () => ({ from: "users" }),
        }),
      ],
    }),
  });

  expect(() => createGateway({ functions })).toThrow(VokeConfigError);
  expect(() => createGateway({ functions })).toThrow(
    "Duplicate Gateway route GET /users/:id"
  );
});

test("does not execute route-only functions through function invocation", async () => {
  const app = new Voke();
  const functions = defineFunctions({
    routes: defineFunction({
      routes: [
        app.get("/health", {
          handler: () => ({ ok: true }),
        }),
      ],
    }),
  });

  createGateway({ functions });

  await expect(
    functions.invoke(
      // Runtime coverage mirrors the type-level @ts-expect-error fixture.
      "routes" as never
    )
  ).rejects.toMatchObject({
    code: "MISSING_FUNCTION",
  });
});
