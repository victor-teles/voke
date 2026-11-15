import type {
  StandardJsonSchemaConverter,
  StandardJsonSchemaOptions,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from "voke";
export type {
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from "voke";

// Results follow the Standard Schema specification: `{ value }` or `{ issues }`.
type Validation<TOutput> = StandardSchemaResult<TOutput>;

interface VokeSchemaMetadata {
  kind: string;
  keys?: readonly string[];
  optional?: boolean;
}

export type VokeSchema<TInput, TOutput = TInput> = StandardSchemaV1<
  TInput,
  TOutput
> & {
  readonly "~voke": VokeSchemaMetadata;
};

type OptionalSchema<TOutput> = VokeSchema<unknown, TOutput | undefined> & {
  readonly "~voke": VokeSchemaMetadata & { readonly optional: true };
};

type InferOutput<TSchema> =
  TSchema extends StandardSchemaV1<unknown, infer TOutput> ? TOutput : never;

type InferObjectOutput<TShape extends Record<string, StandardSchemaV1>> = {
  [TKey in keyof TShape as TShape[TKey] extends {
    readonly "~voke": { readonly optional: true };
  }
    ? never
    : TKey]: InferOutput<TShape[TKey]>;
} & {
  [TKey in keyof TShape as TShape[TKey] extends {
    readonly "~voke": { readonly optional: true };
  }
    ? TKey
    : never]?: InferOutput<TShape[TKey]>;
};

function success(): Validation<undefined>;
function success<TOutput>(value: TOutput): Validation<TOutput>;
function success<TOutput>(value?: TOutput): Validation<TOutput | undefined> {
  return { value };
}

const failure = (
  message: string,
  path: readonly PropertyKey[] = []
): Validation<never> => ({
  issues: [{ message, path }],
});

const withPath = (
  key: string,
  issue: StandardSchemaIssue
): StandardSchemaIssue => ({
  ...issue,
  path: [key, ...(issue.path ?? [])],
});

type JsonSchemaSide = "input" | "output";
type JsonSchemaObject = Record<string, unknown>;

/** Builds a builder's JSON Schema for one side; children are converted with the same options. */
type JsonSchemaProducer = (
  side: JsonSchemaSide,
  options: StandardJsonSchemaOptions
) => JsonSchemaObject;

// The two targets the Standard JSON Schema specification strongly recommends. The keywords used
// here mean the same in both, so one producer serves either.
const supportedJsonSchemaTargets: ReadonlySet<string> = new Set([
  "draft-07",
  "draft-2020-12",
]);

const jsonSchemaConverter = (
  produce: JsonSchemaProducer
): StandardJsonSchemaConverter => {
  const convert =
    (side: JsonSchemaSide) =>
    (options: StandardJsonSchemaOptions): JsonSchemaObject => {
      if (!supportedJsonSchemaTargets.has(options.target)) {
        throw new Error(
          `Unsupported JSON Schema target "${options.target}"; @voke/schema supports "draft-2020-12" and "draft-07"`
        );
      }

      return produce(side, options);
    };

  return { input: convert("input"), output: convert("output") };
};

// A child from another library without a converter is described as "any value". A library
// such as Zod marks its root with `$schema`, which belongs only at the root of the whole schema.
const childJsonSchema = (
  child: StandardSchemaV1,
  side: JsonSchemaSide,
  options: StandardJsonSchemaOptions
): JsonSchemaObject => {
  const { $schema: _dialect, ...childSchema } =
    child["~standard"].jsonSchema?.[side](options) ?? {};

  return childSchema;
};

const makeSchema = <TInput, TOutput>(
  metadata: VokeSchemaMetadata,
  validate: (value: TInput) => Validation<TOutput>,
  jsonSchema: JsonSchemaProducer
): VokeSchema<TInput, TOutput> => ({
  "~standard": {
    jsonSchema: jsonSchemaConverter(jsonSchema),
    validate,
    vendor: "voke",
    version: 1,
  },
  "~voke": metadata,
});

interface StringSchema extends VokeSchema<unknown, string> {
  min(length: number): StringSchema;
  max(length: number): StringSchema;
}

interface StringBounds {
  readonly maxLength?: number;
  readonly minLength?: number;
}

// Every rule applies, so repeated bounds keep the strictest one.
const strictest = (
  current: number | undefined,
  next: number,
  pick: (left: number, right: number) => number
): number => (current === undefined ? next : pick(current, next));

const stringWithRules = (
  rules: readonly ((value: string) => StandardSchemaIssue | undefined)[] = [],
  bounds: StringBounds = {}
): StringSchema => {
  const schema = makeSchema<unknown, string>(
    { kind: "string" },
    (value) => {
      if (typeof value !== "string") {
        return failure("Expected string");
      }

      const issues = rules
        .map((rule) => rule(value))
        .filter((issue): issue is StandardSchemaIssue => issue !== undefined);

      return issues.length === 0 ? success(value) : { issues };
    },
    () => ({ type: "string", ...bounds })
  ) as StringSchema;

  schema.min = (length) =>
    stringWithRules(
      [
        ...rules,
        (value) =>
          value.length < length
            ? { message: `Expected string length to be at least ${length}` }
            : undefined,
      ],
      { ...bounds, minLength: strictest(bounds.minLength, length, Math.max) }
    );
  schema.max = (length) =>
    stringWithRules(
      [
        ...rules,
        (value) =>
          value.length > length
            ? { message: `Expected string length to be at most ${length}` }
            : undefined,
      ],
      { ...bounds, maxLength: strictest(bounds.maxLength, length, Math.min) }
    );

  return Object.freeze(schema);
};

interface NumberSchema extends VokeSchema<unknown, number> {
  int(): NumberSchema;
  max(value: number): NumberSchema;
  min(value: number): NumberSchema;
}

interface NumberBounds {
  readonly integer?: boolean;
  readonly maximum?: number;
  readonly minimum?: number;
}

const numberJsonSchema = (
  bounds: NumberBounds,
  coerce: boolean,
  side: JsonSchemaSide
): JsonSchemaObject => {
  const { integer, ...limits } = bounds;
  const number = { type: integer === true ? "integer" : "number", ...limits };

  // A coercing schema also accepts a numeric string, and always returns a number.
  return coerce && side === "input"
    ? { anyOf: [number, { type: "string" }] }
    : number;
};

const numberWithRules = (
  options: {
    bounds?: NumberBounds;
    coerce?: boolean;
    rules?: readonly ((value: number) => StandardSchemaIssue | undefined)[];
  } = {}
): NumberSchema => {
  const rules = options.rules ?? [];
  const bounds = options.bounds ?? {};
  const schema = makeSchema<unknown, number>(
    { kind: "number" },
    (value) => {
      const candidate =
        options.coerce === true &&
        typeof value === "string" &&
        value.trim() !== ""
          ? Number(value)
          : value;

      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        return failure("Expected number");
      }

      const issues = rules
        .map((rule) => rule(candidate))
        .filter((issue): issue is StandardSchemaIssue => issue !== undefined);

      return issues.length === 0 ? success(candidate) : { issues };
    },
    (side) => numberJsonSchema(bounds, options.coerce === true, side)
  ) as NumberSchema;

  schema.int = () =>
    numberWithRules({
      ...options,
      bounds: { ...bounds, integer: true },
      rules: [
        ...rules,
        (value) =>
          Number.isInteger(value) ? undefined : { message: "Expected integer" },
      ],
    });
  schema.min = (minimum) =>
    numberWithRules({
      ...options,
      bounds: {
        ...bounds,
        minimum: strictest(bounds.minimum, minimum, Math.max),
      },
      rules: [
        ...rules,
        (value) =>
          value < minimum
            ? { message: `Expected number to be at least ${minimum}` }
            : undefined,
      ],
    });
  schema.max = (maximum) =>
    numberWithRules({
      ...options,
      bounds: {
        ...bounds,
        maximum: strictest(bounds.maximum, maximum, Math.min),
      },
      rules: [
        ...rules,
        (value) =>
          value > maximum
            ? { message: `Expected number to be at most ${maximum}` }
            : undefined,
      ],
    });

  return Object.freeze(schema);
};

const boolean = (): VokeSchema<unknown, boolean> =>
  makeSchema(
    { kind: "boolean" },
    (value) =>
      typeof value === "boolean" ? success(value) : failure("Expected boolean"),
    () => ({ type: "boolean" })
  );

const literalType = (value: string | number | boolean | null): string => {
  if (value === null) {
    return "null";
  }

  return typeof value;
};

const literal = <const TValue extends string | number | boolean | null>(
  expected: TValue
): VokeSchema<unknown, TValue> =>
  makeSchema(
    { kind: "literal" },
    (value) =>
      Object.is(value, expected)
        ? success(expected)
        : failure(`Expected ${JSON.stringify(expected)}`),
    () => ({ const: expected, type: literalType(expected) })
  );

const stringEnum = <const TValues extends readonly [string, ...string[]]>(
  values: TValues
): VokeSchema<unknown, TValues[number]> =>
  makeSchema(
    { kind: "enum" },
    (value) =>
      typeof value === "string" && values.includes(value)
        ? success(value)
        : failure(
            `Expected one of ${values.map((option) => JSON.stringify(option)).join(", ")}`
          ),
    () => ({ enum: [...values], type: "string" })
  );

// The object that holds an optional schema leaves its key out of `required`.
const optional = <const TSchema extends StandardSchemaV1>(
  inner: TSchema
): OptionalSchema<InferOutput<TSchema>> =>
  makeSchema(
    { kind: "optional", optional: true },
    (value) =>
      value === undefined
        ? success()
        : (inner["~standard"].validate(value) as Validation<
            InferOutput<TSchema>
          >),
    (side, options) => childJsonSchema(inner, side, options)
  ) as OptionalSchema<InferOutput<TSchema>>;

const isOptionalSchema = (schema: StandardSchemaV1): boolean =>
  (schema as { "~voke"?: VokeSchemaMetadata })["~voke"]?.optional === true;

const objectJsonSchema = (
  shape: Record<string, StandardSchemaV1>,
  side: JsonSchemaSide,
  options: StandardJsonSchemaOptions
): JsonSchemaObject => {
  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];

  for (const [key, child] of Object.entries(shape)) {
    properties[key] = childJsonSchema(child, side, options);

    if (!isOptionalSchema(child)) {
      required.push(key);
    }
  }

  // The validator reports an unknown key as "Unexpected property".
  return {
    additionalProperties: false,
    properties,
    required,
    type: "object",
  };
};

const object = <const TShape extends Record<string, StandardSchemaV1>>(
  shape: TShape
): VokeSchema<unknown, InferObjectOutput<TShape>> =>
  makeSchema(
    { keys: Object.keys(shape), kind: "object" },
    (value): Validation<InferObjectOutput<TShape>> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return failure("Expected object");
      }

      const input = value as Record<string, unknown>;
      const issues: StandardSchemaIssue[] = [];
      const output: Record<string, unknown> = {};
      const expectedKeys = new Set(Object.keys(shape));

      for (const key of Object.keys(input)) {
        if (!expectedKeys.has(key)) {
          issues.push({ message: "Unexpected property", path: [key] });
        }
      }

      for (const [key, child] of Object.entries(shape)) {
        if (!(key in input) && !isOptionalSchema(child)) {
          issues.push({ message: "Required", path: [key] });
          continue;
        }

        const result = child["~standard"].validate(
          input[key]
        ) as Validation<unknown>;

        if (result.issues === undefined) {
          if (result.value !== undefined || key in input) {
            output[key] = result.value;
          }
          continue;
        }

        issues.push(...result.issues.map((issue) => withPath(key, issue)));
      }

      return issues.length === 0
        ? success(output as InferObjectOutput<TShape>)
        : { issues };
    },
    (side, options) => objectJsonSchema(shape, side, options)
  );

const array = <const TItem extends StandardSchemaV1>(
  item: TItem
): VokeSchema<unknown, InferOutput<TItem>[]> =>
  makeSchema(
    { kind: "array" },
    (value) => {
      if (!Array.isArray(value)) {
        return failure("Expected array");
      }

      const output: InferOutput<TItem>[] = [];
      const issues: StandardSchemaIssue[] = [];

      for (const [index, entry] of value.entries()) {
        const result = item["~standard"].validate(entry) as Validation<
          InferOutput<TItem>
        >;

        if (result.issues === undefined) {
          output.push(result.value);
        } else {
          issues.push(
            ...result.issues.map((issue) => ({
              ...issue,
              path: [index, ...(issue.path ?? [])],
            }))
          );
        }
      }

      return issues.length === 0 ? success(output) : { issues };
    },
    (side, options) => ({
      items: childJsonSchema(item, side, options),
      type: "array",
    })
  );

const undefinedSchema = (): VokeSchema<unknown, undefined> =>
  makeSchema(
    { kind: "undefined" },
    (value) =>
      value === undefined ? success() : failure("Expected undefined"),
    () => {
      throw new Error("undefined cannot be represented in JSON Schema");
    }
  );

const nullSchema = (): VokeSchema<unknown, null> =>
  makeSchema(
    { kind: "null" },
    (value) => (value === null ? success(null) : failure("Expected null")),
    () => ({ type: "null" })
  );

export const schema = {
  array,
  boolean,
  coerce: {
    number: () => numberWithRules({ coerce: true }),
  },
  enum: stringEnum,
  literal,
  null: nullSchema,
  number: () => numberWithRules(),
  object,
  optional,
  string: () => stringWithRules(),
  undefined: undefinedSchema,
} as const;
