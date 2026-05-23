import { expect, test } from "bun:test";

import type { MiddlewareHandler } from "hono";

import {
  createGateway,
  defineFunction,
  defineFunctions,
  VokeConfigError,
  Voke,
} from "../src/index";
import type { InvokeError, StandardSchemaV1, VokeEnv } from "../src/index";

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

test("executes route-backed functions through typed route calls and gateway requests", async () => {
  const app = new Voke();
  let middlewareCalls = 0;
  const middleware: MiddlewareHandler<VokeEnv> = async (c, next) => {
    middlewareCalls += 1;
    await next();
  };

  app.use(middleware);

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
      code: "BAD_REQUEST",
      message: "Invalid body for POST /users",
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
      code: "BAD_REQUEST",
      message: "Invalid params for GET /params/:id",
    },
  });
  expect(queryResponse.status).toBe(400);
  expect(await queryResponse.json()).toEqual({
    error: {
      code: "BAD_REQUEST",
      message: "Invalid query for GET /query",
    },
  });
  expect(headersResponse.status).toBe(400);
  expect(await headersResponse.json()).toEqual({
    error: {
      code: "BAD_REQUEST",
      message: "Invalid headers for GET /headers",
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
      code: "INTERNAL_SERVER_ERROR",
      message: "Invalid result for GET /users/:id",
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
      code: "BAD_REQUEST",
      message: "Invalid params for GET /users/:id",
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
