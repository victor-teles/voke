import type {
  StandardJsonSchemaConverter,
  StandardJsonSchemaOptions,
  StandardSchemaInput,
  StandardSchemaIssue,
  StandardSchemaOutput,
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

// `types` declares what a caller should pass; `validate` still accepts any value, as the
// Standard Schema specification requires, so a schema can be run against untrusted data.
export interface VokeSchema<TInput, TOutput = TInput> {
  readonly "~standard": Omit<
    StandardSchemaV1<TInput, TOutput>["~standard"],
    "validate"
  > & {
    validate(
      value: unknown
    ): Validation<TOutput> | Promise<Validation<TOutput>>;
  };
  readonly "~voke": VokeSchemaMetadata;
}

type AnySchema = StandardSchemaV1<unknown, unknown>;

type OptionalSchema<TInput, TOutput> = VokeSchema<
  TInput | undefined,
  TOutput | undefined
> & {
  readonly "~voke": VokeSchemaMetadata & { readonly optional: true };
};

interface OptionalMarker {
  readonly "~voke": { readonly optional: true };
}

// Resolves the intersection so an error message shows `{ id: string }`, not the mapped types.
type Flatten<TObject> = TObject extends infer TResolved
  ? { [TKey in keyof TResolved]: TResolved[TKey] }
  : never;

type ObjectInput<TShape extends Record<string, AnySchema>> = Flatten<
  {
    [TKey in keyof TShape as TShape[TKey] extends OptionalMarker
      ? never
      : TKey]: StandardSchemaInput<TShape[TKey]>;
  } & {
    [TKey in keyof TShape as TShape[TKey] extends OptionalMarker
      ? TKey
      : never]?: StandardSchemaInput<TShape[TKey]>;
  }
>;

type ObjectOutput<TShape extends Record<string, AnySchema>> = Flatten<
  {
    [TKey in keyof TShape as TShape[TKey] extends OptionalMarker
      ? never
      : TKey]: StandardSchemaOutput<TShape[TKey]>;
  } & {
    [TKey in keyof TShape as TShape[TKey] extends OptionalMarker
      ? TKey
      : never]?: StandardSchemaOutput<TShape[TKey]>;
  }
>;

type ChildResult = Validation<unknown> | Promise<Validation<unknown>>;

const isPending = (
  result: ChildResult
): result is Promise<Validation<unknown>> => result instanceof Promise;

const isSettled = (
  results: readonly ChildResult[]
): results is readonly Validation<unknown>[] => !results.some(isPending);

const settleLater = async <TOutput>(
  results: readonly ChildResult[],
  combine: (settled: readonly Validation<unknown>[]) => Validation<TOutput>
): Promise<Validation<TOutput>> => combine(await Promise.all(results));

// A child from another library may validate asynchronously. Only then is the result a promise.
const settle = <TOutput>(
  results: readonly ChildResult[],
  combine: (settled: readonly Validation<unknown>[]) => Validation<TOutput>
): Validation<TOutput> | Promise<Validation<TOutput>> =>
  isSettled(results) ? combine(results) : settleLater(results, combine);

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
          `Unsupported JSON Schema target "${options.target}"; @vokejs/schema supports "draft-2020-12" and "draft-07"`
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
  validate: (
    value: unknown
  ) => Validation<TOutput> | Promise<Validation<TOutput>>,
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

interface StringSchema extends VokeSchema<string> {
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
  const schema = makeSchema<string, string>(
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

interface NumberSchema<TInput = number> extends VokeSchema<TInput, number> {
  int(): NumberSchema<TInput>;
  max(value: number): NumberSchema<TInput>;
  min(value: number): NumberSchema<TInput>;
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

const numberWithRules = <TInput = number>(
  options: {
    bounds?: NumberBounds;
    coerce?: boolean;
    rules?: readonly ((value: number) => StandardSchemaIssue | undefined)[];
  } = {}
): NumberSchema<TInput> => {
  const rules = options.rules ?? [];
  const bounds = options.bounds ?? {};
  const schema = makeSchema<TInput, number>(
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
  ) as NumberSchema<TInput>;

  schema.int = () =>
    numberWithRules<TInput>({
      ...options,
      bounds: { ...bounds, integer: true },
      rules: [
        ...rules,
        (value) =>
          Number.isInteger(value) ? undefined : { message: "Expected integer" },
      ],
    });
  schema.min = (minimum) =>
    numberWithRules<TInput>({
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
    numberWithRules<TInput>({
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

const boolean = (): VokeSchema<boolean> =>
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
): VokeSchema<TValue> =>
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
): VokeSchema<TValues[number]> =>
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
const optional = <const TSchema extends AnySchema>(
  inner: TSchema
): OptionalSchema<
  StandardSchemaInput<TSchema>,
  StandardSchemaOutput<TSchema>
> =>
  // The child's result is returned as is, so it may be a promise.
  makeSchema<StandardSchemaInput<TSchema> | undefined, unknown>(
    { kind: "optional", optional: true },
    (value) =>
      value === undefined ? success() : inner["~standard"].validate(value),
    (side, options) => childJsonSchema(inner, side, options)
  ) as OptionalSchema<
    StandardSchemaInput<TSchema>,
    StandardSchemaOutput<TSchema>
  >;

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

const object = <const TShape extends Record<string, AnySchema>>(
  shape: TShape
): VokeSchema<ObjectInput<TShape>, ObjectOutput<TShape>> =>
  makeSchema<ObjectInput<TShape>, ObjectOutput<TShape>>(
    { keys: Object.keys(shape), kind: "object" },
    (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return failure("Expected object");
      }

      const input = value as Record<string, unknown>;
      const unexpected: StandardSchemaIssue[] = [];
      const expectedKeys = new Set(Object.keys(shape));

      for (const key of Object.keys(input)) {
        if (!expectedKeys.has(key)) {
          unexpected.push({ message: "Unexpected property", path: [key] });
        }
      }

      const entries = Object.entries(shape);
      // One result per shape key, in shape order, so issues keep their order.
      const results = entries.map(([key, child]): ChildResult => {
        if (!(key in input) && !isOptionalSchema(child)) {
          return failure("Required");
        }

        return child["~standard"].validate(input[key]);
      });

      return settle(results, (settled) => {
        const issues = [...unexpected];
        const output: Record<string, unknown> = {};

        for (const [index, result] of settled.entries()) {
          const [key] = entries[index] ?? [""];

          if (result.issues === undefined) {
            if (result.value !== undefined || key in input) {
              output[key] = result.value;
            }
            continue;
          }

          issues.push(...result.issues.map((issue) => withPath(key, issue)));
        }

        return issues.length === 0
          ? success(output as ObjectOutput<TShape>)
          : { issues };
      });
    },
    (side, options) => objectJsonSchema(shape, side, options)
  );

const array = <const TItem extends AnySchema>(
  item: TItem
): VokeSchema<StandardSchemaInput<TItem>[], StandardSchemaOutput<TItem>[]> =>
  makeSchema<StandardSchemaInput<TItem>[], StandardSchemaOutput<TItem>[]>(
    { kind: "array" },
    (value) => {
      if (!Array.isArray(value)) {
        return failure("Expected array");
      }

      const results = value.map(
        (entry): ChildResult => item["~standard"].validate(entry)
      );

      return settle(results, (settled) => {
        const output: unknown[] = [];
        const issues: StandardSchemaIssue[] = [];

        for (const [index, result] of settled.entries()) {
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

        return issues.length === 0
          ? success(output as StandardSchemaOutput<TItem>[])
          : { issues };
      });
    },
    (side, options) => ({
      items: childJsonSchema(item, side, options),
      type: "array",
    })
  );

const undefinedSchema = (): VokeSchema<undefined> =>
  makeSchema(
    { kind: "undefined" },
    (value) =>
      value === undefined ? success() : failure("Expected undefined"),
    () => {
      throw new Error("undefined cannot be represented in JSON Schema");
    }
  );

const nullSchema = (): VokeSchema<null> =>
  makeSchema(
    { kind: "null" },
    (value) => (value === null ? success(null) : failure("Expected null")),
    () => ({ type: "null" })
  );

export const schema = {
  array,
  boolean,
  coerce: {
    number: () => numberWithRules<number | string>({ coerce: true }),
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
