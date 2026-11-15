// Standard Schema (https://standardschema.dev), the validator interface shared by Zod, Valibot,
// ArkType and `@voke/schema`. These declarations are structurally identical to the specification,
// so any compliant validator is assignable without a dependency on `@standard-schema/spec`.

/** A path segment object; the specification allows it alongside plain keys. */
export interface StandardSchemaPathSegment {
  readonly key: PropertyKey;
}

/** One validation issue as a validator reports it. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | StandardSchemaPathSegment)[]
    | undefined;
}

export interface StandardSchemaSuccessResult<TOutput> {
  readonly value: TOutput;
  readonly issues?: undefined;
}

export interface StandardSchemaFailureResult {
  readonly issues: readonly StandardSchemaIssue[];
}

/** `{ value }` on success, `{ issues }` on failure. */
export type StandardSchemaResult<TOutput> =
  | StandardSchemaSuccessResult<TOutput>
  | StandardSchemaFailureResult;

/**
 * The JSON Schema dialect a Standard JSON Schema converter is asked for
 * (https://standardschema.dev/json-schema). Any other string is allowed; a library throws for a
 * target it does not support.
 */
export type StandardJsonSchemaTarget =
  | "draft-2020-12"
  | "draft-07"
  | "openapi-3.0"
  // oxlint-disable-next-line typescript/ban-types -- keeps the literal suggestions, as the specification does
  | ({} & string);

export interface StandardJsonSchemaOptions {
  readonly target: StandardJsonSchemaTarget;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/** The Standard JSON Schema converter at `~standard.jsonSchema`. Each method may throw. */
export interface StandardJsonSchemaConverter {
  readonly input: (
    options: StandardJsonSchemaOptions
  ) => Record<string, unknown>;
  readonly output: (
    options: StandardJsonSchemaOptions
  ) => Record<string, unknown>;
}

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly vendor: string;
    readonly version: 1;
    // Method syntax keeps parameters bivariant, so both a library's `(value: unknown)` and a
    // hand-written validator with a typed parameter are accepted.
    validate(
      value: TInput
    ): StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
    readonly types?:
      | {
          readonly input: TInput;
          readonly output: TOutput;
        }
      | undefined;
    /** Standard JSON Schema: present when the library can describe the schema as JSON Schema. */
    readonly jsonSchema?: StandardJsonSchemaConverter | undefined;
  };
}

/** A validation issue after Voke normalized its path to plain keys. */
export interface ValidationIssue {
  message: string;
  path?: readonly PropertyKey[];
}

type StandardProps<TSchema> = TSchema extends {
  readonly "~standard": infer TProps;
}
  ? TProps
  : never;

// `types` is optional in the specification (Zod declares `types?: ... | undefined`), so it is read
// by key; a pattern with `types?: infer` does not match an object that omits the property.
// Without `types` this is `undefined`, not `never`: `never extends X` is true, which would skip
// the `validate` fallback below.
type DeclaredTypes<TSchema> = "types" extends keyof StandardProps<TSchema>
  ? NonNullable<StandardProps<TSchema>["types" & keyof StandardProps<TSchema>]>
  : undefined;

// A schema that declares `types` (every library does) is read from them; a hand-written schema
// without `types` is read from its `validate` signature.
export type StandardSchemaInput<TSchema> =
  DeclaredTypes<TSchema> extends { readonly input: infer TInput }
    ? TInput
    : TSchema extends {
          readonly "~standard": { validate(value: infer TInput): unknown };
        }
      ? TInput
      : never;

export type StandardSchemaOutput<TSchema> =
  DeclaredTypes<TSchema> extends { readonly output: infer TOutput }
    ? TOutput
    : TSchema extends {
          readonly "~standard": {
            validate(
              value: never
            ):
              | StandardSchemaResult<infer TOutput>
              | Promise<StandardSchemaResult<infer TOutput>>;
          };
        }
      ? TOutput
      : never;

const toKey = (segment: PropertyKey | StandardSchemaPathSegment): PropertyKey =>
  typeof segment === "object" ? segment.key : segment;

const normalizeIssue = (issue: StandardSchemaIssue): ValidationIssue =>
  issue.path === undefined || issue.path.length === 0
    ? { message: issue.message }
    : { message: issue.message, path: issue.path.map(toKey) };

/** The one place Voke reads a validation result. */
export const readStandardResult = <TOutput>(
  result: StandardSchemaResult<TOutput>
): { ok: true; value: TOutput } | { issues: ValidationIssue[]; ok: false } =>
  result.issues === undefined
    ? { ok: true, value: result.value }
    : { issues: result.issues.map(normalizeIssue), ok: false };

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const convertedJsonSchema = (
  schema: StandardSchemaV1,
  io: "input" | "output"
): Record<string, unknown> | undefined => {
  const converter = schema["~standard"].jsonSchema;

  if (converter === undefined) {
    return undefined;
  }

  try {
    const converted = converter[io]({ target: "draft-2020-12" });

    return isJsonObject(converted) ? converted : undefined;
  } catch {
    // The specification lets a converter throw for a schema JSON Schema cannot represent
    // (a Zod date, `@voke/schema`'s `undefined`); that schema then has no JSON Schema.
    return undefined;
  }
};

/**
 * The one place Voke reads a schema's JSON Schema (draft 2020-12) for its input or output side:
 * the Standard JSON Schema converter, else a hand-written top-level `jsonSchema` object, else
 * `undefined`.
 */
export const readJsonSchema = (
  schema: StandardSchemaV1 | undefined,
  io: "input" | "output"
): Record<string, unknown> | undefined => {
  if (schema === undefined) {
    return undefined;
  }

  const converted = convertedJsonSchema(schema, io);

  if (converted !== undefined) {
    return converted;
  }

  const handWritten: unknown = (schema as { jsonSchema?: unknown }).jsonSchema;

  return isJsonObject(handWritten) ? handWritten : undefined;
};

/** `path.to.field: message`, or the message alone without a path. */
export const formatValidationIssue = (issue: ValidationIssue): string =>
  issue.path === undefined || issue.path.length === 0
    ? issue.message
    : `${issue.path.map(String).join(".")}: ${issue.message}`;
