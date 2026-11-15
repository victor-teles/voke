import { expect, test } from "bun:test";

import { z } from "zod";

import { voke } from "../src/app";
import { createFunctions, fn, http, InvokeError } from "../src/invoke";
import type { StandardSchemaV1 } from "../src/invoke";
import { toContractJsonSchema } from "../src/remote";
import { route } from "../src/route-builder";
import { readJsonSchema } from "../src/standard-schema";

const user = z.object({ id: z.string() });

// Local invocation needs the Function Registry activated by a Gateway.
const activated = <TFunctions extends Parameters<typeof voke>[0]>(
  functions: TFunctions
): TFunctions => {
  voke(functions, { config: { name: "standard-schema-test" } });
  return functions;
};

const zodFunctions = () =>
  activated(
    createFunctions({
      getUser: fn({
        handler: (payload) => ({ id: payload.id }),
        input: user,
        output: user,
      }),
    })
  );

test("accepts a Zod schema as a Function Contract", async () => {
  await expect(
    zodFunctions().invoke("getUser", { id: "usr_1" })
  ).resolves.toEqual({ id: "usr_1" });
});

test("reports Zod validation issues with plain key paths", async () => {
  const failure = await zodFunctions()
    .invoke("getUser", { id: 1 } as never)
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(InvokeError);
  expect(failure).toMatchObject({
    code: "INVALID_PAYLOAD",
    issues: [{ path: ["id"] }],
  });
});

test("validates a route body with Zod through the Gateway", async () => {
  const gateway = voke(
    createFunctions({
      http: http({
        routes: route.post("/users", {
          body: z.object({ name: z.string() }),
          handler: (request) => ({ name: request.body.name }),
        }),
      }),
    }),
    { config: { name: "zod-api" } }
  );
  const post = (body: unknown) =>
    gateway.request("/users", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

  const valid = await post({ name: "Ada" });
  const invalid = await post({ name: 1 });

  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ data: { name: "Ada" } });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    error: {
      issues: [{ path: ["body", "name"] }],
      message: "Invalid body",
    },
  });
});

// A specification-shaped validator written by hand: `{ value }` on success, `{ issues }` on
// failure, async, and with `{ key }` path segments, which Voke normalizes to plain keys.
const orderId: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    validate: async (value) => {
      await Promise.resolve();

      return typeof (value as { id?: unknown }).id === "string"
        ? { value: value as { id: string } }
        : { issues: [{ message: "id is required", path: [{ key: "id" }] }] };
    },
    vendor: "voke-test",
    version: 1,
  },
};

test("accepts an async specification-shaped schema and normalizes { key } path segments", async () => {
  const functions = activated(
    createFunctions({
      getOrder: fn({
        handler: (payload) => payload,
        input: orderId,
        output: orderId,
      }),
    })
  );

  await expect(functions.invoke("getOrder", { id: "ord_1" })).resolves.toEqual({
    id: "ord_1",
  });

  const failure = await functions
    .invoke("getOrder", {} as never)
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({
    code: "INVALID_PAYLOAD",
    issues: [{ message: "id is required", path: ["id"] }],
    message: "Invalid payload for getOrder: id: id is required",
  });
});

test("readJsonSchema reads a Zod schema's 2020-12 JSON Schema for each side", () => {
  const withDefault = z.object({
    id: z.string(),
    role: z.string().default("member"),
  });

  expect(readJsonSchema(withDefault, "input")).toEqual({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: {
      id: { type: "string" },
      role: { default: "member", type: "string" },
    },
    required: ["id"],
    type: "object",
  });
  expect(readJsonSchema(withDefault, "output")).toMatchObject({
    additionalProperties: false,
    required: ["id", "role"],
    type: "object",
  });
});

test("readJsonSchema treats a converter that throws as no JSON Schema", () => {
  expect(readJsonSchema(z.date(), "input")).toBeUndefined();
});

test("readJsonSchema reads a hand-written jsonSchema property", () => {
  const handWritten = {
    ...orderId,
    jsonSchema: { properties: { id: { type: "string" } }, type: "object" },
  };

  expect(readJsonSchema(handWritten, "output")).toEqual({
    properties: { id: { type: "string" } },
    type: "object",
  });
});

test("readJsonSchema returns undefined for a schema without JSON Schema", () => {
  expect(readJsonSchema(orderId, "input")).toBeUndefined();
});

test("toContractJsonSchema keeps only the keywords of the contract subset", () => {
  expect(
    toContractJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        id: { minLength: 1, type: "string" },
        role: { enum: ["admin", "member"], type: "string" },
        tags: { items: { type: "string" }, type: "array" },
      },
      required: ["id"],
      type: "object",
    })
  ).toEqual({
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      role: { enum: ["admin", "member"], type: "string" },
      tags: { items: { type: "string" }, type: "array" },
    },
    required: ["id"],
    type: "object",
  });
});

test("toContractJsonSchema turns a node the subset cannot express into true", () => {
  expect(
    toContractJsonSchema({
      properties: {
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        nullable: { type: ["string", "null"] },
        ref: { $ref: "#/$defs/user" },
      },
      type: "object",
    })
  ).toEqual({
    properties: { either: true, nullable: true, ref: true },
    type: "object",
  });
  expect(toContractJsonSchema(null)).toBe(true);
  expect(toContractJsonSchema("string")).toBe(true);
  expect(toContractJsonSchema({ not: { type: "string" } })).toBe(true);
});
