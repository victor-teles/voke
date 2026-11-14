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
