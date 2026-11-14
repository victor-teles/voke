import type { StandardSchemaIssue, StandardSchemaV1 } from "voke";
export type {
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from "voke";

type Validation<TOutput> =
  | { data: TOutput; success: true }
  | { issues: StandardSchemaIssue[]; success: false };

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
function success<TOutput>(data: TOutput): Validation<TOutput>;
function success<TOutput>(data?: TOutput): Validation<TOutput | undefined> {
  return {
    data,
    success: true,
  };
}

const failure = (
  message: string,
  path: readonly PropertyKey[] = []
): Validation<never> => ({
  issues: [{ message, path }],
  success: false,
});

const withPath = (
  key: string,
  issue: StandardSchemaIssue
): StandardSchemaIssue => ({
  ...issue,
  path: [key, ...(issue.path ?? [])],
});

const makeSchema = <TInput, TOutput>(
  metadata: VokeSchemaMetadata,
  validate: (value: TInput) => Validation<TOutput>
): VokeSchema<TInput, TOutput> => ({
  "~standard": {
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

const stringWithRules = (
  rules: readonly ((value: string) => StandardSchemaIssue | undefined)[] = []
): StringSchema => {
  const schema = makeSchema<unknown, string>({ kind: "string" }, (value) => {
    if (typeof value !== "string") {
      return failure("Expected string");
    }

    const issues = rules
      .map((rule) => rule(value))
      .filter((issue): issue is StandardSchemaIssue => issue !== undefined);

    return issues.length === 0 ? success(value) : { issues, success: false };
  }) as StringSchema;

  schema.min = (length) =>
    stringWithRules([
      ...rules,
      (value) =>
        value.length < length
          ? { message: `Expected string length to be at least ${length}` }
          : undefined,
    ]);
  schema.max = (length) =>
    stringWithRules([
      ...rules,
      (value) =>
        value.length > length
          ? { message: `Expected string length to be at most ${length}` }
          : undefined,
    ]);

  return Object.freeze(schema);
};

interface NumberSchema extends VokeSchema<unknown, number> {
  int(): NumberSchema;
  max(value: number): NumberSchema;
  min(value: number): NumberSchema;
}

const numberWithRules = (
  options: {
    coerce?: boolean;
    rules?: readonly ((value: number) => StandardSchemaIssue | undefined)[];
  } = {}
): NumberSchema => {
  const rules = options.rules ?? [];
  const schema = makeSchema<unknown, number>({ kind: "number" }, (value) => {
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

    return issues.length === 0
      ? success(candidate)
      : { issues, success: false };
  }) as NumberSchema;

  schema.int = () =>
    numberWithRules({
      ...options,
      rules: [
        ...rules,
        (value) =>
          Number.isInteger(value) ? undefined : { message: "Expected integer" },
      ],
    });
  schema.min = (minimum) =>
    numberWithRules({
      ...options,
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
  makeSchema({ kind: "boolean" }, (value) =>
    typeof value === "boolean" ? success(value) : failure("Expected boolean")
  );

const literal = <const TValue extends string | number | boolean | null>(
  expected: TValue
): VokeSchema<unknown, TValue> =>
  makeSchema({ kind: "literal" }, (value) =>
    Object.is(value, expected)
      ? success(expected)
      : failure(`Expected ${JSON.stringify(expected)}`)
  );

const stringEnum = <const TValues extends readonly [string, ...string[]]>(
  values: TValues
): VokeSchema<unknown, TValues[number]> =>
  makeSchema({ kind: "enum" }, (value) =>
    typeof value === "string" && values.includes(value)
      ? success(value)
      : failure(
          `Expected one of ${values.map((option) => JSON.stringify(option)).join(", ")}`
        )
  );

const optional = <const TSchema extends StandardSchemaV1>(
  inner: TSchema
): OptionalSchema<InferOutput<TSchema>> =>
  makeSchema({ kind: "optional", optional: true }, (value) =>
    value === undefined
      ? success()
      : (inner["~standard"].validate(value) as Validation<InferOutput<TSchema>>)
  ) as OptionalSchema<InferOutput<TSchema>>;

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
        if (
          !(key in input) &&
          (child as { "~voke"?: VokeSchemaMetadata })["~voke"]?.optional !==
            true
        ) {
          issues.push({ message: "Required", path: [key] });
          continue;
        }

        const result = child["~standard"].validate(
          input[key]
        ) as Validation<unknown>;

        if (result.success) {
          if (result.data !== undefined || key in input) {
            output[key] = result.data;
          }
          continue;
        }

        issues.push(...result.issues.map((issue) => withPath(key, issue)));
      }

      return issues.length === 0
        ? success(output as InferObjectOutput<TShape>)
        : { issues, success: false };
    }
  );

const array = <const TItem extends StandardSchemaV1>(
  item: TItem
): VokeSchema<unknown, InferOutput<TItem>[]> =>
  makeSchema({ kind: "array" }, (value) => {
    if (!Array.isArray(value)) {
      return failure("Expected array");
    }

    const output: InferOutput<TItem>[] = [];
    const issues: StandardSchemaIssue[] = [];

    for (const [index, entry] of value.entries()) {
      const result = item["~standard"].validate(entry) as Validation<
        InferOutput<TItem>
      >;

      if (result.success) {
        output.push(result.data);
      } else {
        issues.push(
          ...result.issues.map((issue) => ({
            ...issue,
            path: [index, ...(issue.path ?? [])],
          }))
        );
      }
    }

    return issues.length === 0 ? success(output) : { issues, success: false };
  });

const undefinedSchema = (): VokeSchema<unknown, undefined> =>
  makeSchema({ kind: "undefined" }, (value) =>
    value === undefined ? success() : failure("Expected undefined")
  );

const nullSchema = (): VokeSchema<unknown, null> =>
  makeSchema({ kind: "null" }, (value) =>
    value === null ? success(null) : failure("Expected null")
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
