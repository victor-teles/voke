import { InvokeError, VokeConfigError } from "voke";
import type {
  ContractJsonSchema as JsonSchema,
  FunctionContractArtifact,
  FunctionContractMetadata,
  InvokeOptions,
} from "voke";

type JsonSchemaType<TSchema> = TSchema extends true
  ? unknown
  : TSchema extends false
    ? never
    : TSchema extends { const: infer TValue }
      ? TValue
      : TSchema extends { enum: readonly (infer TValue)[] }
        ? TValue
        : TSchema extends { type: "string" }
          ? string
          : TSchema extends { type: "number" | "integer" }
            ? number
            : TSchema extends { type: "boolean" }
              ? boolean
              : TSchema extends { type: "null" }
                ? null
                : TSchema extends { type: "array"; items: infer TItems }
                  ? JsonSchemaType<TItems>[]
                  : TSchema extends {
                        properties: infer TProperties;
                        required?: readonly string[];
                        type: "object";
                      }
                    ? JsonObjectType<TProperties, TSchema["required"]>
                    : unknown;

type JsonObjectType<TProperties, TRequired> =
  TProperties extends Record<string, JsonSchema>
    ? {
        [TKey in keyof TProperties as TKey extends RequiredKey<TRequired>
          ? TKey
          : never]: JsonSchemaType<TProperties[TKey]>;
      } & {
        [TKey in keyof TProperties as TKey extends RequiredKey<TRequired>
          ? never
          : TKey]?: JsonSchemaType<TProperties[TKey]>;
      }
    : Record<string, unknown>;

type RequiredKey<TRequired> = TRequired extends readonly (infer TKey)[]
  ? TKey & string
  : never;

type RemoteInput<TFunction> = TFunction extends { input: infer TInput }
  ? JsonSchemaType<TInput>
  : undefined;

type RemoteOutput<TFunction> = TFunction extends { output: infer TOutput }
  ? JsonSchemaType<TOutput>
  : never;

type RemotePayloadKey<TFunctions> = {
  [TKey in keyof TFunctions]: TFunctions[TKey] extends { input: JsonSchema }
    ? TKey
    : never;
}[keyof TFunctions];

type RemoteZeroInputKey<TFunctions> = {
  [TKey in keyof TFunctions]: TFunctions[TKey] extends { input: JsonSchema }
    ? never
    : TKey;
}[keyof TFunctions];

/**
 * The invoke options a Remote Function Registry honours. `timeoutMs` bounds each attempt and
 * cancels its request; `retries` adds attempts after a timeout, a failed request or a 5xx answer.
 */
export type RemoteInvokeOptions = Pick<
  InvokeOptions,
  "retries" | "timeoutMs" | "trace"
>;

export interface RemoteFunctionRegistry<
  TFunctions extends Record<string, FunctionContractMetadata> = Record<
    string,
    FunctionContractMetadata
  >,
> {
  readonly invoke: {
    <TKey extends RemotePayloadKey<TFunctions>>(
      functionName: TKey,
      payload: RemoteInput<TFunctions[TKey]>,
      options?: RemoteInvokeOptions
    ): Promise<RemoteOutput<TFunctions[TKey]>>;
    <TKey extends RemoteZeroInputKey<TFunctions>>(
      functionName: TKey,
      payload?: undefined,
      options?: RemoteInvokeOptions
    ): Promise<RemoteOutput<TFunctions[TKey]>>;
  };
}

interface JsonSchemaIssue {
  message: string;
  path: string;
}

// The wire request of the Dev Function Invoke Endpoint; core reads the same shape.
interface RemoteInvokeRequest {
  contractFingerprint?: string;
  payload?: unknown;
  trace?: Record<string, boolean | number | string | undefined>;
}

// Same rule as core's remote config; private so @voke/remote stays provider-neutral.
const toEnvKey = (value: string): string =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/[^A-Za-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .toUpperCase();

const normalizeOrigin = (origin: string): string =>
  origin.replace(/[/]+$/u, "");

const pathFor = (path: string, key: string): string =>
  path === "" ? key : `${path}.${key}`;

type JsonSchemaValidator = (
  schema: JsonSchema | undefined,
  value: unknown,
  path?: string
) => JsonSchemaIssue[];

const validateArrayJsonSchema = (
  schema: Exclude<JsonSchema, boolean>,
  value: unknown,
  path: string,
  validate: JsonSchemaValidator
): JsonSchemaIssue[] => {
  if (!Array.isArray(value)) {
    return [{ message: "expected array", path }];
  }

  return value.flatMap((item, index) =>
    validate(schema.items, item, `${path}[${index}]`)
  );
};

const validateObjectJsonSchema = (
  schema: Exclude<JsonSchema, boolean>,
  value: unknown,
  path: string,
  validate: JsonSchemaValidator
): JsonSchemaIssue[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ message: "expected object", path }];
  }

  const record = value as Record<string, unknown>;
  const requiredIssues = (schema.required ?? [])
    .filter((key) => !(key in record))
    .map((key) => ({
      message: "is required",
      path: pathFor(path, key),
    }));
  const propertyIssues = Object.entries(schema.properties ?? {}).flatMap(
    ([key, propertySchema]) =>
      key in record
        ? validate(propertySchema, record[key], pathFor(path, key))
        : []
  );

  return [...requiredIssues, ...propertyIssues];
};

const validateTypedJsonSchema = (
  schema: Exclude<JsonSchema, boolean>,
  value: unknown,
  path: string,
  validate: JsonSchemaValidator
): JsonSchemaIssue[] => {
  switch (schema.type) {
    case "array": {
      return validateArrayJsonSchema(schema, value, path, validate);
    }
    case "integer": {
      return typeof value === "number" && Number.isInteger(value)
        ? []
        : [{ message: "expected integer", path }];
    }
    case "null": {
      return value === null ? [] : [{ message: "expected null", path }];
    }
    case "object": {
      return validateObjectJsonSchema(schema, value, path, validate);
    }
    default: {
      return typeof value === schema.type
        ? []
        : [{ message: `expected ${schema.type}`, path }];
    }
  }
};

const validateJsonSchema = (
  schema: JsonSchema | undefined,
  value: unknown,
  path = ""
): JsonSchemaIssue[] => {
  if (schema === undefined || schema === true) {
    return [];
  }

  if (schema === false) {
    return [{ message: "value is not allowed", path }];
  }

  if (schema.const !== undefined && value !== schema.const) {
    return [{ message: `expected ${JSON.stringify(schema.const)}`, path }];
  }

  if (schema.enum !== undefined && !schema.enum.includes(value as never)) {
    return [{ message: "expected one of enum values", path }];
  }

  return schema.type === undefined
    ? []
    : validateTypedJsonSchema(schema, value, path, validateJsonSchema);
};

const formatJsonSchemaIssues = (issues: JsonSchemaIssue[]): string =>
  issues
    .map((issue) =>
      issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`
    )
    .join("; ");

const remoteOriginEnvName = (project: string): string =>
  `VOKE_REMOTE_${toEnvKey(project)}_ORIGIN`;

const resolveRemoteOrigin = (project: string): string => {
  const origin = process.env[remoteOriginEnvName(project)];

  if (origin === undefined || origin.trim() === "") {
    throw new VokeConfigError(
      `Remote Function Registry "${project}" has no runtime target. Configure remotes.${project}.targets for this stage.`
    );
  }

  return normalizeOrigin(origin);
};

const invokeUrl = (project: string, functionName: string): string =>
  `${resolveRemoteOrigin(project)}/_voke/functions/${encodeURIComponent(functionName)}/invoke`;

const supportedOptions: ReadonlySet<string> = new Set([
  "retries",
  "timeoutMs",
  "trace",
] satisfies (keyof RemoteInvokeOptions)[]);

const invalidOption = (functionName: string, message: string): InvokeError =>
  new InvokeError(`Remote Function ${functionName} ${message}`, {
    code: "INVALID_OPTIONS",
    functionName,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readOptions = (
  functionName: string,
  options: unknown
): RemoteInvokeOptions => {
  if (options === undefined) {
    return {};
  }

  if (!isRecord(options)) {
    throw invalidOption(functionName, "invoke options must be an object");
  }

  for (const [option, value] of Object.entries(options)) {
    if (value !== undefined && !supportedOptions.has(option)) {
      throw invalidOption(
        functionName,
        `does not support the invoke option "${option}"`
      );
    }
  }

  const { retries, timeoutMs } = options;
  const validTimeout =
    timeoutMs === undefined ||
    (typeof timeoutMs === "number" &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0);
  const validRetries =
    retries === undefined ||
    (Number.isInteger(retries) && Number(retries) >= 0);

  if (!validTimeout) {
    throw invalidOption(
      functionName,
      'invoke option "timeoutMs" must be a finite number above 0'
    );
  }

  if (!validRetries) {
    throw invalidOption(
      functionName,
      'invoke option "retries" must be an integer of 0 or more'
    );
  }

  return options as RemoteInvokeOptions;
};

// "Not JSON" is a normal answer to map, so a parse failure becomes this marker.
const notJson = Symbol("not JSON");

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return notJson;
  }
};

const errorMessageOf = (body: unknown): string | undefined => {
  if (!(isRecord(body) && isRecord(body.error))) {
    return undefined;
  }

  const { message } = body.error;

  return typeof message === "string" && message !== "" ? message : undefined;
};

interface RemoteAttempt {
  body: string;
  functionName: string;
  timeoutMs: number | undefined;
  url: string;
}

const requestOnce = async (
  attempt: RemoteAttempt
): Promise<{ body: unknown; response: Response }> => {
  const { functionName, timeoutMs } = attempt;
  // One signal per attempt: the limit covers the request and reading the body.
  const signal =
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(attempt.url, {
      body: attempt.body,
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    });

    return { body: parseJson(await response.text()), response };
  } catch (error) {
    if (signal?.aborted === true) {
      throw new InvokeError(
        `Remote Function ${functionName} timed out after ${timeoutMs}ms`,
        { cause: error, code: "TIMEOUT", functionName }
      );
    }

    const reason = error instanceof Error ? error.message : String(error);

    throw new InvokeError(
      `Remote Function ${functionName} request failed: ${reason}`,
      { cause: error, code: "TRANSPORT_FAILED", functionName }
    );
  }
};

const answerOf = async (attempt: RemoteAttempt): Promise<unknown> => {
  const { functionName } = attempt;
  const { body, response } = await requestOnce(attempt);
  const { status } = response;

  if (!response.ok) {
    throw new InvokeError(
      errorMessageOf(body) ??
        `Remote Function invocation failed with HTTP ${status}`,
      {
        code: status === 404 ? "MISSING_FUNCTION" : "TRANSPORT_FAILED",
        functionName,
        statusCode: status,
      }
    );
  }

  if (!isRecord(body)) {
    throw new InvokeError(
      `Remote Function ${functionName} answered HTTP ${status} without a Voke data envelope`,
      { code: "TRANSPORT_FAILED", functionName, statusCode: status }
    );
  }

  return body.data;
};

// Repeat only when repeating can help: a timeout, a request that failed, or a 5xx answer.
const isRetryable = (error: unknown): boolean => {
  if (!(error instanceof InvokeError)) {
    return false;
  }

  if (error.code === "TIMEOUT") {
    return true;
  }

  return (
    error.code === "TRANSPORT_FAILED" &&
    (error.statusCode === undefined || error.statusCode >= 500)
  );
};

const answerWithRetries = async (
  attempt: RemoteAttempt,
  retries: number
): Promise<unknown> => {
  for (let remaining = retries; ; remaining -= 1) {
    try {
      return await answerOf(attempt);
    } catch (error) {
      if (remaining === 0 || !isRetryable(error)) {
        throw error;
      }
    }
  }
};

export const createRemoteFunctions = <
  const TFunctions extends Record<string, FunctionContractMetadata>,
>(
  project: string,
  artifact: FunctionContractArtifact<TFunctions>
): RemoteFunctionRegistry<TFunctions> => {
  if (artifact.project !== project) {
    throw new VokeConfigError(
      `Remote Function Registry "${project}" received a contract for "${artifact.project}"`
    );
  }

  const registry = {} as RemoteFunctionRegistry<TFunctions>;

  Object.defineProperty(registry, "invoke", {
    enumerable: false,
    value: async (
      functionName: string,
      payload?: unknown,
      rawOptions?: unknown
    ): Promise<unknown> => {
      const contract = artifact.functions[functionName];

      if (contract === undefined) {
        throw new InvokeError(`Remote Function not found: ${functionName}`, {
          code: "MISSING_FUNCTION",
          functionName,
        });
      }

      const options = readOptions(functionName, rawOptions);
      const inputIssues = validateJsonSchema(contract.input, payload);

      if (inputIssues.length > 0) {
        throw new InvokeError(
          `Invalid remote payload for ${functionName}: ${formatJsonSchemaIssues(inputIssues)}`,
          {
            code: "INVALID_PAYLOAD",
            functionName,
          }
        );
      }

      const result = await answerWithRetries(
        {
          body: JSON.stringify({
            contractFingerprint: artifact.fingerprint,
            payload,
            trace: options.trace,
          } satisfies RemoteInvokeRequest),
          functionName,
          timeoutMs: options.timeoutMs,
          url: invokeUrl(project, functionName),
        },
        options.retries ?? 0
      );
      const outputIssues = validateJsonSchema(contract.output, result);

      if (outputIssues.length > 0) {
        throw new InvokeError(
          `Invalid remote result from ${functionName}: ${formatJsonSchemaIssues(outputIssues)}`,
          {
            code: "INVALID_RESULT",
            functionName,
          }
        );
      }

      return result;
    },
  });

  return registry;
};
