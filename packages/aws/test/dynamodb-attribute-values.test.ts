import { describe, expect, test } from "bun:test";

import {
  fromAttributeValue,
  fromAttributeValueMap,
  toAttributeValueMap,
} from "../src/dynamodb-attribute-values";

// "SGVsbG8=" is "Hello" in base64; Lambda delivers binary attributes base64-encoded in JSON.
const hello = new Uint8Array([72, 101, 108, 108, 111]);

describe("fromAttributeValue converts every DynamoDB type tag like unmarshall", () => {
  test.each([
    ["S", { S: "text" }, "text"],
    ["N integer", { N: "42" }, 42],
    ["N decimal", { N: "-1.5" }, -1.5],
    ["BOOL", { BOOL: false }, false],
    ["NULL", { NULL: true }, null],
    ["B", { B: "SGVsbG8=" }, hello],
    ["SS", { SS: ["a", "b"] }, new Set(["a", "b"])],
    ["NS", { NS: ["1", "2.5"] }, new Set([1, 2.5])],
    ["BS", { BS: ["SGVsbG8="] }, new Set([hello])],
    ["L", { L: [{ S: "a" }, { N: "1" }] }, ["a", 1]],
    ["M", { M: { name: { S: "a" } } }, { name: "a" }],
  ] as const)("%s", (_tag, value, expected) => {
    expect(fromAttributeValue(value)).toEqual(expected);
  });
});

test("fromAttributeValueMap converts nested maps and lists", () => {
  expect(
    fromAttributeValueMap({
      id: { S: "o1" },
      lines: {
        L: [
          {
            M: {
              qty: { N: "2" },
              tags: { SS: ["gift"] },
            },
          },
        ],
      },
      shipping: { M: { address: { M: { city: { S: "Lisbon" } } } } },
    })
  ).toEqual({
    id: "o1",
    lines: [{ qty: 2, tags: new Set(["gift"]) }],
    shipping: { address: { city: "Lisbon" } },
  });
});

test("an unknown type tag throws instead of guessing", () => {
  expect(() => fromAttributeValue({ X: "1" } as never)).toThrow(
    'Unsupported DynamoDB attribute value type "X"'
  );
  expect(() => fromAttributeValue({} as never)).toThrow(
    "A DynamoDB attribute value must have exactly one type tag"
  );
  expect(() => fromAttributeValue({ N: "abc" })).toThrow(
    'Invalid DynamoDB number "abc"'
  );
});

test("a number beyond Number.MAX_SAFE_INTEGER stays a number and loses precision", () => {
  // Documented trade-off: one JavaScript type for N; integers above 2^53 - 1 are rounded.
  const value = fromAttributeValue({ N: "9007199254740993" });

  expect(typeof value).toBe("number");
  expect(value).toBe(9_007_199_254_740_992);
});

test("toAttributeValueMap is the inverse of fromAttributeValueMap for plain values", () => {
  const item = {
    active: true,
    blob: hello,
    count: 3,
    missing: undefined,
    nested: { list: ["x", 1, { deep: false }] },
    nothing: null,
    scores: new Set([1, 2]),
    tags: new Set(["a"]),
  };
  const marshalled = toAttributeValueMap(item);

  expect(marshalled).toEqual({
    active: { BOOL: true },
    blob: { B: "SGVsbG8=" },
    count: { N: "3" },
    nested: {
      M: {
        list: { L: [{ S: "x" }, { N: "1" }, { M: { deep: { BOOL: false } } }] },
      },
    },
    nothing: { NULL: true },
    scores: { NS: ["1", "2"] },
    tags: { SS: ["a"] },
  });
  expect(fromAttributeValueMap(marshalled)).toEqual({
    active: true,
    blob: hello,
    count: 3,
    nested: { list: ["x", 1, { deep: false }] },
    nothing: null,
    scores: new Set([1, 2]),
    tags: new Set(["a"]),
  });
});

test("toAttributeValueMap rejects values DynamoDB cannot store", () => {
  expect(() => toAttributeValueMap({ when: new Date(0) })).toThrow(
    "Cannot convert"
  );
  expect(() => toAttributeValueMap({ fn: () => 1 })).toThrow("Cannot convert");
});
