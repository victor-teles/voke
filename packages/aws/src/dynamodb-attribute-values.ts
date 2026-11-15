// DynamoDB attribute-value JSON ↔ plain values, for DynamoDB Stream Event Sources. It mirrors the
// defaults of `unmarshall`/`marshall` from `@aws-sdk/util-dynamodb` (sets as `Set`, binary as
// `Uint8Array`, `undefined` attributes removed) without adding that package, with one deliberate
// difference: every `N` becomes a JavaScript number. `unmarshall` returns a `bigint` for an integer
// beyond `Number.MAX_SAFE_INTEGER`; here such a value keeps the `number` type and is rounded to the
// nearest double, so one attribute never changes type between records.
import { Buffer } from "node:buffer";

export type AttributeValue =
  | { readonly B: string }
  | { readonly BOOL: boolean }
  | { readonly BS: readonly string[] }
  | { readonly L: readonly AttributeValue[] }
  | { readonly M: AttributeValueMap }
  | { readonly N: string }
  | { readonly NS: readonly string[] }
  | { readonly NULL: true }
  | { readonly S: string }
  | { readonly SS: readonly string[] };

export type AttributeValueMap = Readonly<Record<string, AttributeValue>>;

const fromNumber = (value: string): number => {
  const number = Number(value);

  if (value.trim() === "" || !Number.isFinite(number)) {
    throw new Error(`Invalid DynamoDB number ${JSON.stringify(value)}`);
  }

  return number;
};

// Converts every attribute of a map, dropping `undefined` ones (as `marshall` does by default).
const convertAttributes = <TValue, TResult>(
  attributes: Readonly<Record<string, TValue>>,
  convert: (value: TValue) => TResult
): Record<string, TResult> => {
  const result: Record<string, TResult> = {};

  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      result[name] = convert(value);
    }
  }

  return result;
};

const fromBinary = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

/** One attribute value → its plain value. Throws for an unknown or malformed type tag. */
export const fromAttributeValue = (value: AttributeValue): unknown => {
  const tags = Object.keys(value);

  if (tags.length !== 1) {
    throw new Error(
      "A DynamoDB attribute value must have exactly one type tag"
    );
  }

  const [tag] = tags as [string];
  const content = (value as Record<string, unknown>)[tag];

  switch (tag) {
    case "S": {
      return content as string;
    }
    case "N": {
      return fromNumber(content as string);
    }
    case "BOOL": {
      return content as boolean;
    }
    case "NULL": {
      return null;
    }
    case "B": {
      return fromBinary(content as string);
    }
    case "SS": {
      return new Set(content as string[]);
    }
    case "NS": {
      return new Set((content as string[]).map(fromNumber));
    }
    case "BS": {
      return new Set((content as string[]).map(fromBinary));
    }
    case "L": {
      return (content as AttributeValue[]).map(fromAttributeValue);
    }
    case "M": {
      return convertAttributes(
        content as AttributeValueMap,
        fromAttributeValue
      );
    }
    default: {
      throw new Error(`Unsupported DynamoDB attribute value type "${tag}"`);
    }
  }
};

/** An item, key or image in attribute-value JSON → a plain object. */
export const fromAttributeValueMap = (
  map: AttributeValueMap
): Record<string, unknown> => convertAttributes(map, fromAttributeValue);

const describeValue = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? (value.constructor?.name ?? "object")
    : typeof value;

const toSetAttributeValue = (set: ReadonlySet<unknown>): AttributeValue => {
  const members = [...set];

  if (members.every((member) => typeof member === "string")) {
    return { SS: members };
  }

  if (members.every((member) => typeof member === "number")) {
    return { NS: members.map(String) };
  }

  if (members.every((member) => member instanceof Uint8Array)) {
    return {
      BS: members.map((member) => Buffer.from(member).toString("base64")),
    };
  }

  throw new Error(
    "Cannot convert a Set to a DynamoDB attribute value: members must all be strings, numbers or Uint8Arrays"
  );
};

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
};

/** One plain value → its attribute value. `undefined` is not a value; callers skip it. */
export const toAttributeValue = (value: unknown): AttributeValue => {
  if (value === null) {
    return { NULL: true };
  }

  switch (typeof value) {
    case "string": {
      return { S: value };
    }
    case "number":
    case "bigint": {
      return { N: String(value) };
    }
    case "boolean": {
      return { BOOL: value };
    }
    case "object": {
      if (value instanceof Uint8Array) {
        return { B: Buffer.from(value).toString("base64") };
      }

      if (value instanceof Set) {
        return toSetAttributeValue(value);
      }

      if (Array.isArray(value)) {
        return {
          L: value
            .filter((member) => member !== undefined)
            .map(toAttributeValue),
        };
      }

      if (isPlainObject(value)) {
        return {
          M: convertAttributes(
            value as Record<string, unknown>,
            toAttributeValue
          ),
        };
      }

      break;
    }
    default: {
      break;
    }
  }

  throw new Error(
    `Cannot convert a ${describeValue(value)} to a DynamoDB attribute value`
  );
};

/** A plain object → attribute-value JSON, dropping `undefined` attributes. */
export const toAttributeValueMap = (
  item: Readonly<Record<string, unknown>>
): Record<string, AttributeValue> => convertAttributes(item, toAttributeValue);
