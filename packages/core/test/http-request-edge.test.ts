import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { schema } from "@voke/schema";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { voke } from "../src/app";
import { VokeConfigError } from "../src/errors";
import { createFunctions, fn, http, InvokeError } from "../src/invoke";
import { Voke } from "../src/route-builder";
import { withEnv } from "./support/env";

const app = new Voke();
const nameBody = schema.object({ name: schema.string() });

// The nested call is wired after the registry exists, so the handler can reach it.
const nested: { invoke?: (payload: unknown) => Promise<unknown> } = {};

const functions = createFunctions({
  edge: http({
    routes: [
      app.get("/q", {
        handler: (request) => ({ page: request.query.page }),
        query: schema.object({ page: schema.string() }),
      }),
      app.get("/zq", {
        handler: (request) => ({ page: request.query.page }),
        query: z.object({ page: z.string() }),
      }),
      app.get("/h", {
        handler: (request) => ({ tenant: request.headers["x-tenant"] }),
        headers: schema.object({ "x-tenant": schema.string() }),
      }),
      app.get("/zh", {
        handler: (request) => ({ tenant: request.headers["x-tenant"] }),
        headers: z.object({ "x-tenant": z.string() }),
      }),
      app.get("/plain", {
        handler: (request) => ({
          headers: { "x-request-id": request.headers["x-request-id"] },
          headersArePlain:
            Object.getPrototypeOf(request.headers) === Object.prototype,
          ownProto: Object.hasOwn(request.query, "__proto__"),
          query: Object.hasOwn(request.query, "__proto__") ? {} : request.query,
          queryIsPlain:
            Object.getPrototypeOf(request.query) === Object.prototype,
          rawHeaders: request.raw.headers instanceof Headers,
        }),
      }),
      app.post("/b", {
        body: nameBody,
        handler: (request) => ({ name: request.body.name }),
      }),
      app.post("/optional", {
        body: schema.optional(nameBody),
        handler: (request) => ({ name: request.body?.name ?? null }),
      }),
      app.post("/mw", {
        body: nameBody,
        handler: (request) => ({ name: request.body.name }),
        middleware: [
          async (c, next) => {
            await c.req.json();
            await next();
          },
        ],
      }),
      app.post("/raw", {
        body: nameBody,
        handler: async (request) => ({
          name: request.body.name,
          raw: (await request.raw.json()) as unknown,
        }),
      }),
      app.post("/nested", {
        handler: async () => await nested.invoke?.({ to: 42 }),
      }),
      app.get("/out", {
        // Deliberately the wrong shape, to reach the run-time output check.
        handler: () => ({ id: 1, passwordHash: "x" }) as never,
        output: schema.object({ id: schema.string() }),
      }),
      app.get("/e401", {
        handler: () => {
          throw new HTTPException(401, { message: "Sign in first" });
        },
      }),
      app.get("/e429", {
        handler: () => {
          throw new HTTPException(429);
        },
      }),
      app.get("/e401res", {
        handler: () => {
          throw new HTTPException(401, {
            res: new Response("token expired", {
              headers: { "www-authenticate": 'Bearer error="invalid_token"' },
              status: 401,
            }),
          });
        },
      }),
      app.get("/e503", {
        handler: () => {
          throw new HTTPException(503, { message: "db down" });
        },
      }),
    ],
  }),
  inner: fn({
    handler: (payload) => ({ to: payload.to }),
    input: schema.object({ to: schema.string() }),
    output: schema.object({ to: schema.string() }),
  }),
});

nested.invoke = (payload) =>
  functions.invoke("inner", payload as { to: string });

const gateway = voke(functions, { config: { name: "http-edge" } });

const request = (path: string, init?: RequestInit) =>
  withEnv({ VOKE_DEV_SUMMARY: undefined }, () => gateway.request(path, init));

const postJson = (path: string, body: string, contentType: string) =>
  request(path, {
    body,
    headers: { "content-type": contentType },
    method: "POST",
  });

const errorLog = spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  errorLog.mockClear();
});

afterAll(() => {
  errorLog.mockRestore();
});

const internalError = {
  error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
};

test("a query schema of either validator receives a plain object", async () => {
  for (const path of ["/q?page=2", "/zq?page=2"]) {
    const response = await request(path);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { page: "2" } });
  }
});

test("a headers schema of either validator receives the request's headers, extra ones included", async () => {
  for (const path of ["/h", "/zh"]) {
    const response = await request(path, {
      headers: {
        "X-Tenant": "acme",
        accept: "application/json",
        "user-agent": "voke-test",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { tenant: "acme" } });
  }
});

test("without schemas, query and headers are plain objects with lower-case names and joined repeats", async () => {
  const response = await request("/plain?page=2&tag=a&tag=b&flag", {
    headers: { "X-Request-Id": "r1" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      headers: { "x-request-id": "r1" },
      headersArePlain: true,
      ownProto: false,
      query: { flag: "", page: "2", tag: "a,b" },
      queryIsPlain: true,
      rawHeaders: true,
    },
  });
});

test("a query key named __proto__ is an ordinary own property", async () => {
  const response = await request("/plain?__proto__=x");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      headers: {},
      headersArePlain: true,
      ownProto: true,
      query: {},
      queryIsPlain: true,
      rawHeaders: true,
    },
  });
});

test("a @voke/schema query object rejects an undeclared parameter", async () => {
  const response = await request("/q?page=2&debug=1");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "INVALID_REQUEST",
      issues: [{ message: "Unexpected property", path: ["query", "debug"] }],
      message: "Invalid query",
    },
  });
});

test("a missing query parameter answers 400 INVALID_REQUEST", async () => {
  const response = await request("/q");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "INVALID_REQUEST",
      issues: [{ message: "Required", path: ["query", "page"] }],
      message: "Invalid query",
    },
  });
});

test("malformed JSON answers 400 without the parser's message, and an empty body is undefined", async () => {
  const malformed = await postJson("/b", "{oops", "application/json");

  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({
    error: {
      code: "INVALID_REQUEST",
      issues: [{ message: "Malformed JSON", path: ["body"] }],
      message: "Invalid body",
    },
  });

  const empty = await postJson("/optional", "", "application/json");

  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ data: { name: null } });
});

test("JSON media types are compared on the type, case-insensitively, with +json suffixes", async () => {
  for (const contentType of [
    "application/vnd.api+json",
    "Application/JSON; charset=utf-8",
  ]) {
    const response = await postJson("/b", '{"name":"Ada"}', contentType);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { name: "Ada" } });
  }
});

test("a body with another or no content type answers 415", async () => {
  const responses = [
    await postJson("/b", '{"name":"Ada"}', "text/plain"),
    await postJson("/b", '{"name":"Ada"}', "text/plain; x=application/json"),
    await request("/b", {
      body: new Blob(['{"name":"Ada"}']),
      method: "POST",
    }),
  ];

  for (const response of responses) {
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Unsupported content type: send application/json",
      },
    });
  }
});

test("a body schema still works after route middleware read the body", async () => {
  const response = await postJson("/mw", '{"name":"Ada"}', "application/json");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { name: "Ada" } });
});

test("the handler can still read the raw body after the body schema ran", async () => {
  const response = await postJson("/raw", '{"name":"Ada"}', "application/json");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { name: "Ada", raw: { name: "Ada" } },
  });
});

test("a wrong method answers 404 NOT_FOUND", async () => {
  const response = await request("/q", { method: "DELETE" });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
});

test("a nested invoke failure inside a handler is a generic 500", async () => {
  const response = await request("/nested", { method: "POST" });
  const text = await response.text();

  expect(response.status).toBe(500);
  expect(JSON.parse(text)).toEqual(internalError);
  expect(text).not.toContain("inner");
  expect(text).not.toContain("Expected string");
  expect(errorLog).toHaveBeenCalledTimes(1);
});

test("an output that fails its schema is a generic 500, with the issues only in the log", async () => {
  const response = await request("/out");
  const text = await response.text();

  expect(response.status).toBe(500);
  expect(JSON.parse(text)).toEqual(internalError);
  expect(text).not.toContain("passwordHash");
  expect(text).not.toContain("issues");
  expect(errorLog).toHaveBeenCalledTimes(1);

  const [line] = errorLog.mock.calls[0] ?? [];
  const logged = JSON.parse(String(line)) as {
    code?: unknown;
    issues?: unknown;
  };

  expect(logged.code).toBe("INVALID_RESULT");
  expect(Array.isArray(logged.issues)).toBe(true);
});

test("an HTTPException answers with its own status", async () => {
  const unauthorized = await request("/e401");

  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toEqual({
    error: { code: "UNAUTHORIZED", message: "Sign in first" },
  });

  const limited = await request("/e429");

  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({
    error: { code: "TOO_MANY_REQUESTS", message: "Too many requests" },
  });

  const withResponse = await request("/e401res");

  expect(withResponse.status).toBe(401);
  expect(withResponse.headers.get("www-authenticate")).toBe(
    'Bearer error="invalid_token"'
  );
  expect(await withResponse.text()).toBe("token expired");

  const unavailable = await request("/e503");
  const text = await unavailable.text();

  expect(unavailable.status).toBe(503);
  expect(JSON.parse(text)).toEqual(internalError);
  expect(text).not.toContain("db down");
});

test("functions.route takes plain objects and keeps throwing InvokeError with full issues", async () => {
  await expect(
    functions.route("GET", "/plain", {
      headers: { "X-Request-Id": "r1" },
      query: { page: "2" },
    })
  ).resolves.toMatchObject({
    headers: { "x-request-id": "r1" },
    query: { page: "2" },
  });

  const missingQuery = await functions
    .route("GET", "/q", { query: {} as never })
    .catch((error: unknown) => error);

  expect(missingQuery).toBeInstanceOf(InvokeError);
  expect(missingQuery).toMatchObject({ code: "INVALID_PAYLOAD" });

  const badOutput = await functions
    .route("GET", "/out")
    .catch((error: unknown) => error);

  expect(badOutput).toBeInstanceOf(InvokeError);
  expect(badOutput).toMatchObject({ code: "INVALID_RESULT" });
  expect(JSON.stringify((badOutput as InvokeError).issues)).toContain(
    "passwordHash"
  );
});

test("a @voke/schema headers object with a name that is not lower-case fails composition", () => {
  const invalid = createFunctions({
    edge: http({
      routes: [
        app.get("/tenant", {
          handler: () => ({ ok: true }),
          headers: schema.object({ "X-Tenant": schema.string() }),
        }),
      ],
    }),
  });

  expect(() => voke(invalid, { config: { name: "http-edge-bad" } })).toThrow(
    VokeConfigError
  );
  expect(() => voke(invalid, { config: { name: "http-edge-bad" } })).toThrow(
    /GET \/tenant.*X-Tenant/u
  );
});
