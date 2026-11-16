import { expect, test } from "bun:test";

import { createAuthorizers, jwtAuthorizer, lambdaAuthorizer } from "@voke/aws";
import { schema } from "@voke/schema";
import { createFunctions, functionRegistryEntries, http, route } from "voke";
import type { AnyFunctionDefinition, VokeConfigError } from "voke";
import { z } from "zod";

import { createOpenApiDocument } from "../src/index";
import type { OpenApiDocument } from "../src/index";

type Entries = readonly (readonly [string, AnyFunctionDefinition])[];

const entriesOf = (functions: object): Entries =>
  functionRegistryEntries(functions);

const documentFor = (
  functions: object,
  options?: Parameters<typeof createOpenApiDocument>[0]["options"]
): OpenApiDocument =>
  createOpenApiDocument({
    functions: entriesOf(functions),
    name: "orders",
    ...(options === undefined ? {} : { options }),
  });

const errorRef = {
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
};

const ok = () => ({ ok: true });

const envelope = (data: object) => ({
  content: {
    "application/json": {
      schema: { properties: { data }, required: ["data"], type: "object" },
    },
  },
  description: "Success",
});

test("converts :name parameters and a trailing * to path templates", () => {
  const document = documentFor(
    createFunctions({
      http: http({
        routes: [
          route.get("/users/:id/posts/:postId", { handler: ok }),
          route.get("/files/*", { handler: ok }),
        ],
      }),
    })
  );

  expect(Object.keys(document.paths)).toEqual([
    "/users/{id}/posts/{postId}",
    "/files/{proxy}",
  ]);
  expect(document.paths["/files/{proxy}"]?.get?.parameters).toEqual([
    { in: "path", name: "proxy", required: true, schema: { type: "string" } },
  ]);
});

test("documents template parameters without a params schema as required strings", () => {
  const document = documentFor(
    createFunctions({
      http: http({ routes: [route.get("/users/:id", { handler: ok })] }),
    })
  );
  const operation = document.paths["/users/{id}"]?.get;

  expect(operation?.parameters).toEqual([
    { in: "path", name: "id", required: true, schema: { type: "string" } },
  ]);
  // Nothing is validated, so the route cannot answer 400.
  expect(Object.keys(operation?.responses ?? {})).toEqual(["200", "500"]);
});

test("rejects a path parameter API Gateway cannot route", () => {
  expect(() =>
    documentFor(
      createFunctions({
        http: http({ routes: [route.get("/users/:id?", { handler: ok })] }),
      })
    )
  ).toThrow('Route "GET /users/:id?" of Function "http"');
  expect(() =>
    documentFor(
      createFunctions({
        http: http({ routes: [route.get("/files/*/raw", { handler: ok })] }),
      })
    )
  ).toThrow('Route "GET /files/*/raw" of Function "http"');
});

test("reads params, query and headers from @voke/schema", () => {
  const document = documentFor(
    createFunctions({
      http: http({
        routes: [
          route.get("/users/:id", {
            handler: ok,
            headers: schema.object({ "x-tenant": schema.string() }),
            params: schema.object({ id: schema.string().min(3) }),
            query: schema.object({
              page: schema.optional(schema.coerce.number().int()),
            }),
          }),
        ],
      }),
    })
  );

  expect(document.paths["/users/{id}"]?.get?.parameters).toEqual([
    {
      in: "path",
      name: "id",
      required: true,
      schema: { minLength: 3, type: "string" },
    },
    {
      in: "query",
      name: "page",
      required: false,
      schema: { anyOf: [{ type: "integer" }, { type: "string" }] },
    },
    {
      in: "header",
      name: "x-tenant",
      required: true,
      schema: { type: "string" },
    },
  ]);
});

test("reads params, query and headers from Zod", () => {
  const document = documentFor(
    createFunctions({
      http: http({
        routes: [
          route.get("/orders/:orderId", {
            handler: ok,
            headers: z.object({ "x-request-id": z.string().optional() }),
            params: z.object({ orderId: z.uuid() }),
            query: z.object({ expand: z.enum(["items", "customer"]) }),
          }),
        ],
      }),
    })
  );

  expect(document.paths["/orders/{orderId}"]?.get?.parameters).toEqual([
    {
      in: "path",
      name: "orderId",
      required: true,
      schema: expect.objectContaining({ format: "uuid", type: "string" }),
    },
    {
      in: "query",
      name: "expand",
      required: true,
      schema: { enum: ["items", "customer"], type: "string" },
    },
    {
      in: "header",
      name: "x-request-id",
      required: false,
      schema: { type: "string" },
    },
  ]);
});

test("documents a body and wraps the output in the { data } envelope", () => {
  const document = documentFor(
    createFunctions({
      http: http({
        routes: [
          route.post("/users", {
            body: z.object({ name: z.string() }),
            handler: (request) => ({ id: "usr_1", name: request.body.name }),
            output: z.object({ id: z.string(), name: z.string() }),
          }),
        ],
      }),
    })
  );
  const operation = document.paths["/users"]?.post;

  expect(operation?.requestBody).toEqual({
    content: {
      "application/json": {
        schema: {
          properties: { name: { type: "string" } },
          required: ["name"],
          type: "object",
        },
      },
    },
    required: true,
  });
  expect(operation?.responses["200"]).toEqual({
    content: {
      "application/json": {
        schema: {
          properties: {
            data: {
              additionalProperties: false,
              properties: { id: { type: "string" }, name: { type: "string" } },
              required: ["id", "name"],
              type: "object",
            },
          },
          required: ["data"],
          type: "object",
        },
      },
    },
    description: "Success",
  });
  expect(operation?.responses["400"]).toEqual({
    ...errorRef,
    description: "Invalid request",
  });
  expect(operation?.responses["415"]).toEqual({
    ...errorRef,
    description: "Unsupported content type",
  });
});

test("a route without output documents data as any value", () => {
  const document = documentFor(
    createFunctions({
      http: http({ routes: [route.get("/health", { handler: ok })] }),
    })
  );

  expect(
    document.paths["/health"]?.get?.responses["200"]?.content?.[
      "application/json"
    ]?.schema
  ).toEqual({ properties: { data: {} }, required: ["data"], type: "object" });
});

const securedFunctions = () =>
  createFunctions({
    admin: http({
      authorizer: "jwt",
      authorizers: createAuthorizers({
        apiKey: lambdaAuthorizer({
          function: "checkKey",
          identitySource: "$request.querystring.key",
        }),
        jwt: jwtAuthorizer({
          audience: "orders-api",
          issuer: "https://auth.example.com",
        }),
        partner: lambdaAuthorizer({
          function: "checkPartner",
          identitySource: ["$request.header.X-Partner-Key"],
        }),
      }),
      routes: [
        route.get("/admin/users", { handler: ok }),
        route.get("/admin/keys", { authorizer: "apiKey", handler: ok }),
        route.get("/admin/partners", { authorizer: "partner", handler: ok }),
        route.get("/admin/status", { authorizer: "none", handler: ok }),
      ],
    }),
    public: http({ routes: [route.get("/status", { handler: ok })] }),
  });

test("applies the Default HTTP Authorizer, a Route Authorizer Override and none", () => {
  const document = documentFor(securedFunctions());

  expect(document.paths["/admin/users"]?.get?.security).toEqual([{ jwt: [] }]);
  expect(document.paths["/admin/keys"]?.get?.security).toEqual([
    { apiKey: [] },
  ]);
  expect(document.paths["/admin/status"]?.get?.security).toEqual([]);
  expect(document.paths["/status"]?.get?.security).toEqual([]);
  expect(document.paths["/admin/users"]?.get?.responses).toMatchObject({
    "401": { description: "Unauthorized" },
    "403": { description: "Forbidden" },
  });
  expect(document.paths["/admin/status"]?.get?.responses).not.toHaveProperty(
    "401"
  );
});

test("describes JWT and Lambda authorizers as security schemes", () => {
  expect(documentFor(securedFunctions()).components.securitySchemes).toEqual({
    apiKey: {
      description:
        "Lambda authorizer. Identity sources: $request.querystring.key",
      in: "query",
      name: "key",
      type: "apiKey",
    },
    jwt: {
      bearerFormat: "JWT",
      description: "JWT issued by https://auth.example.com",
      scheme: "bearer",
      type: "http",
    },
    partner: {
      description:
        "Lambda authorizer. Identity sources: $request.header.X-Partner-Key",
      in: "header",
      name: "X-Partner-Key",
      type: "apiKey",
    },
  });
});

test("a route naming an authorizer its Function does not declare is a config error", () => {
  const failure = (() => {
    try {
      documentFor(
        createFunctions({
          http: http({
            authorizer: "missing",
            routes: [route.get("/private", { handler: ok })],
          }),
        })
      );
    } catch (error) {
      return error as VokeConfigError;
    }
  })();

  expect(failure?.name).toBe("VokeConfigError");
  expect(failure?.message).toContain('Route "GET /private" of Function "http"');
});

test("uses meta for summary, description, tags, operationId and deprecated", () => {
  const document = documentFor(
    createFunctions({
      orders: http({
        routes: [
          route.get("/orders/:id", {
            handler: ok,
            meta: {
              deprecated: true,
              description: "Reads one order.",
              operationId: "getOrder",
              summary: "Get an order",
              tags: ["orders", "public"],
            },
          }),
          route.post("/orders", { handler: ok }),
        ],
      }),
    })
  );

  expect(document.paths["/orders/{id}"]?.get).toMatchObject({
    deprecated: true,
    description: "Reads one order.",
    operationId: "getOrder",
    summary: "Get an order",
    tags: ["orders", "public"],
  });
  expect(document.paths["/orders"]?.post).toMatchObject({
    operationId: "ordersPostOrders",
    tags: ["orders"],
  });
  expect(document.paths["/orders"]?.post).not.toHaveProperty("deprecated");
  expect(document.paths["/orders"]?.post).not.toHaveProperty("summary");
});

test("default operationIds come from the key, the method and the path", () => {
  const document = documentFor(
    createFunctions({
      userApi: http({
        routes: [
          route.get("/", { handler: ok }),
          route.get("/users/:id", { handler: ok }),
          route.delete("/user-groups/:groupId/*", { handler: ok }),
        ],
      }),
    })
  );

  expect(document.paths["/"]?.get?.operationId).toBe("userApiGet");
  expect(document.paths["/users/{id}"]?.get?.operationId).toBe(
    "userApiGetUsersById"
  );
  expect(
    document.paths["/user-groups/{groupId}/{proxy}"]?.delete?.operationId
  ).toBe("userApiDeleteUserGroupsByGroupIdProxy");
});

test("a duplicate operationId is a config error that names the route", () => {
  expect(() =>
    documentFor(
      createFunctions({
        http: http({
          routes: [
            route.get("/a", { handler: ok, meta: { operationId: "same" } }),
            route.get("/b", { handler: ok, meta: { operationId: "same" } }),
          ],
        }),
      })
    )
  ).toThrow(
    'Route "GET /b" of Function "http" uses the operationId "same", which route "GET /a" already uses'
  );
});

test("leaves out hidden routes and the openapi Plugin's own Functions", () => {
  const functions = createFunctions({
    http: http({
      routes: [
        route.get("/visible", { handler: ok }),
        route.get("/internal", { handler: ok, meta: { hidden: true } }),
      ],
    }),
  });
  const docs = http({ routes: [route.get("/openapi.json", { handler: ok })] });
  const document = createOpenApiDocument({
    functions: [...entriesOf(functions), ["openapi-docs", docs]],
    name: "orders",
  });

  expect(Object.keys(document.paths)).toEqual(["/visible"]);
});

test("removes $schema from embedded schemas", () => {
  const text = JSON.stringify(
    documentFor(
      createFunctions({
        http: http({
          routes: [
            route.post("/users", {
              body: z.object({ name: z.string() }),
              handler: () => ({ id: "usr_1" }),
              output: z.object({ id: z.string() }),
              query: z.object({ dryRun: z.string().optional() }),
            }),
          ],
        }),
      })
    )
  );

  expect(text).not.toContain("$schema");
});

test("reads info and servers from the options", () => {
  const functions = createFunctions({
    http: http({ routes: [route.get("/health", { handler: ok })] }),
  });

  expect(documentFor(functions)).toMatchObject({
    info: { title: "orders", version: "0.0.0" },
    openapi: "3.1.0",
  });
  expect(documentFor(functions)).not.toHaveProperty("servers");
  expect(
    documentFor(functions, {
      description: "Order management.",
      servers: ["https://api.example.com"],
      title: "Orders API",
      version: "2.1.0",
    })
  ).toMatchObject({
    info: {
      description: "Order management.",
      title: "Orders API",
      version: "2.1.0",
    },
    servers: [{ url: "https://api.example.com" }],
  });
});

test("the same registry always gives the same document", () => {
  expect(JSON.stringify(documentFor(securedFunctions()))).toBe(
    JSON.stringify(documentFor(securedFunctions()))
  );
});

test("builds the whole document for a three-route registry", () => {
  const user = schema.object({ id: schema.string(), name: schema.string() });
  const document = documentFor(
    createFunctions({
      users: http({
        routes: [
          route.get("/users", { handler: () => [] }),
          route.get("/users/:id", {
            handler: () => ({ id: "usr_1", name: "Ada" }),
            output: user,
            params: schema.object({ id: schema.string() }),
          }),
          route.post("/users", {
            body: schema.object({ name: schema.string() }),
            handler: () => ({ id: "usr_2", name: "Grace" }),
            meta: { summary: "Create a user", tags: ["users"] },
            output: user,
          }),
        ],
      }),
    })
  );
  const userSchema = {
    additionalProperties: false,
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id", "name"],
    type: "object",
  };
  const serverError = { ...errorRef, description: "Internal server error" };
  const badRequest = { ...errorRef, description: "Invalid request" };

  expect(document).toEqual({
    components: {
      schemas: {
        Error: {
          properties: {
            error: {
              properties: {
                code: { type: "string" },
                details: {},
                issues: {
                  items: {
                    properties: {
                      message: { type: "string" },
                      path: {
                        items: { type: ["string", "integer"] },
                        type: "array",
                      },
                    },
                    required: ["message"],
                    type: "object",
                  },
                  type: "array",
                },
                message: { type: "string" },
              },
              required: ["message"],
              type: "object",
            },
          },
          required: ["error"],
          type: "object",
        },
      },
    },
    info: { title: "orders", version: "0.0.0" },
    openapi: "3.1.0",
    paths: {
      "/users": {
        get: {
          operationId: "usersGetUsers",
          responses: { "200": envelope({}), "500": serverError },
          security: [],
          tags: ["users"],
        },
        post: {
          operationId: "usersPostUsers",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  additionalProperties: false,
                  properties: { name: { type: "string" } },
                  required: ["name"],
                  type: "object",
                },
              },
            },
            required: true,
          },
          responses: {
            "200": envelope(userSchema),
            "400": badRequest,
            "415": { ...errorRef, description: "Unsupported content type" },
            "500": serverError,
          },
          security: [],
          summary: "Create a user",
          tags: ["users"],
        },
      },
      "/users/{id}": {
        get: {
          operationId: "usersGetUsersById",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": envelope(userSchema),
            "400": badRequest,
            "500": serverError,
          },
          security: [],
          tags: ["users"],
        },
      },
    },
  });
});
