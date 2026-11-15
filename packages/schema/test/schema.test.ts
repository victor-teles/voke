import { expect, test } from "bun:test";

import { schema } from "../src/index";

// The value is optional so a call that validates `undefined` can omit it.
const validate = (
  target: { "~standard": { validate: (value: never) => unknown } },
  value?: unknown
) => target["~standard"].validate(value as never);

test("returns { value } on success, following the Standard Schema specification", () => {
  expect(validate(schema.string(), "ada")).toEqual({ value: "ada" });
  expect(validate(schema.coerce.number(), "42")).toEqual({ value: 42 });
  expect(validate(schema.optional(schema.string()))).toEqual({
    value: undefined,
  });
  expect(
    validate(schema.object({ tags: schema.array(schema.string()) }), {
      tags: ["a"],
    })
  ).toEqual({ value: { tags: ["a"] } });
});

test("returns { issues } on failure, with paths and no success flag", () => {
  const result = validate(
    schema.object({ tags: schema.array(schema.string()) }),
    { extra: true, tags: [1] }
  );

  expect(result).toEqual({
    issues: [
      { message: "Unexpected property", path: ["extra"] },
      { message: "Expected string", path: ["tags", 0] },
    ],
  });
  expect(result).not.toHaveProperty("success");
});

type JsonSide = "input" | "output";

const jsonSchemaOf = (
  target: {
    "~standard": {
      jsonSchema?: {
        input: (options: { target: string }) => Record<string, unknown>;
        output: (options: { target: string }) => Record<string, unknown>;
      };
    };
  },
  side: JsonSide = "input",
  draft = "draft-2020-12"
): Record<string, unknown> | undefined =>
  target["~standard"].jsonSchema?.[side]({ target: draft });

test("string, number, boolean and null produce their JSON Schema", () => {
  expect(jsonSchemaOf(schema.string())).toEqual({ type: "string" });
  expect(jsonSchemaOf(schema.string().min(1).max(40))).toEqual({
    maxLength: 40,
    minLength: 1,
    type: "string",
  });
  expect(jsonSchemaOf(schema.number())).toEqual({ type: "number" });
  expect(jsonSchemaOf(schema.number().int().min(1).max(100))).toEqual({
    maximum: 100,
    minimum: 1,
    type: "integer",
  });
  expect(jsonSchemaOf(schema.boolean())).toEqual({ type: "boolean" });
  expect(jsonSchemaOf(schema.null())).toEqual({ type: "null" });
});

test("repeated bounds keep the strictest one, as the validator does", () => {
  expect(jsonSchemaOf(schema.string().min(5).min(2).max(3).max(9))).toEqual({
    maxLength: 3,
    minLength: 5,
    type: "string",
  });
});

test("coerce.number accepts a numeric string on the input side only", () => {
  const page = schema.coerce.number().int().min(1);

  expect(jsonSchemaOf(page, "input")).toEqual({
    anyOf: [{ minimum: 1, type: "integer" }, { type: "string" }],
  });
  expect(jsonSchemaOf(page, "output")).toEqual({ minimum: 1, type: "integer" });
});

test("literal and enum produce const and enum", () => {
  expect(jsonSchemaOf(schema.literal("draft"))).toEqual({
    const: "draft",
    type: "string",
  });
  expect(jsonSchemaOf(schema.literal(3))).toEqual({ const: 3, type: "number" });
  expect(jsonSchemaOf(schema.literal(null))).toEqual({
    const: null,
    type: "null",
  });
  expect(jsonSchemaOf(schema.enum(["a", "b"]))).toEqual({
    enum: ["a", "b"],
    type: "string",
  });
});

test("array, object and optional produce nested JSON Schema", () => {
  const user = schema.object({
    id: schema.string(),
    nickname: schema.optional(schema.string()),
    tags: schema.array(schema.string()),
  });

  expect(jsonSchemaOf(user)).toEqual({
    // The validator rejects unknown keys, so the schema does too.
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      nickname: { type: "string" },
      tags: { items: { type: "string" }, type: "array" },
    },
    required: ["id", "tags"],
    type: "object",
  });
  expect(jsonSchemaOf(schema.optional(schema.number()))).toEqual({
    type: "number",
  });
});

test("an object passes each side to its properties", () => {
  const query = schema.object({ page: schema.coerce.number() });

  expect(jsonSchemaOf(query, "input")).toMatchObject({
    properties: { page: { anyOf: [{ type: "number" }, { type: "string" }] } },
  });
  expect(jsonSchemaOf(query, "output")).toMatchObject({
    properties: { page: { type: "number" } },
  });
});

test("a child from another library keeps its JSON Schema without a nested $schema", () => {
  const foreign = {
    "~standard": {
      jsonSchema: {
        input: () => ({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          format: "uuid",
          type: "string",
        }),
        output: () => ({ type: "string" }),
      },
      validate: (value: unknown) => ({ value: value as string }),
      vendor: "other",
      version: 1 as const,
    },
  };

  expect(jsonSchemaOf(schema.object({ id: foreign }))).toMatchObject({
    properties: { id: { format: "uuid", type: "string" } },
  });
});

test("draft-07 is supported; any other target throws", () => {
  expect(jsonSchemaOf(schema.string(), "input", "draft-07")).toEqual({
    type: "string",
  });
  expect(() => jsonSchemaOf(schema.string(), "input", "openapi-3.0")).toThrow(
    'Unsupported JSON Schema target "openapi-3.0"'
  );
});

test("undefined cannot be represented in JSON Schema", () => {
  expect(() => jsonSchemaOf(schema.undefined())).toThrow(
    "undefined cannot be represented in JSON Schema"
  );
  expect(() =>
    jsonSchemaOf(schema.object({ nothing: schema.undefined() }))
  ).toThrow("undefined cannot be represented in JSON Schema");
});
