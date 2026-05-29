import { json, jsonError } from "@voke/http";
import type { Hono } from "hono";
import {
  InvokeError,
  invokeRegistryFunction,
  toEnvKey,
  VokeConfigError,
} from "voke";
import type {
  FunctionRegistry,
  FunctionRegistryInput,
  InvokableFunctionDefinition,
  InvokeOptions,
  StandardSchemaV1,
  VokeConfig,
  VokeEnv,
} from "voke";
type JsonPrimitive = boolean | null | number | string;

export type JsonSchema =
  | boolean
  | {
      additionalProperties?: boolean | JsonSchema;
      const?: JsonPrimitive;
      enum?: readonly JsonPrimitive[];
      items?: JsonSchema;
      properties?: Record<string, JsonSchema>;
      required?: readonly string[];
      type?:
        | "array"
        | "boolean"
        | "integer"
        | "null"
        | "number"
        | "object"
        | "string";
    };

export interface FunctionContractMetadata {
  input?: JsonSchema;
  output: JsonSchema;
}

export interface FunctionContractArtifact<
  TFunctions extends Record<string, FunctionContractMetadata> = Record<
    string,
    FunctionContractMetadata
  >,
> {
  fingerprint: string;
  functions: TFunctions;
  project: string;
  version: 1;
}

export type RemoteTarget =
  | string
  | {
      contract?: string;
      origin: string;
    };

export interface VokeRemoteConfig {
  contract: string;
  origin: string;
  out: string;
}

export interface VokeRemoteConfigInput {
  contract?: string;
  out?: string;
  targets: Record<string, RemoteTarget>;
}

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
      options?: InvokeOptions
    ): Promise<RemoteOutput<TFunctions[TKey]>>;
    <TKey extends RemoteZeroInputKey<TFunctions>>(
      functionName: TKey,
      payload?: undefined,
      options?: InvokeOptions
    ): Promise<RemoteOutput<TFunctions[TKey]>>;
  };
}

interface JsonSchemaIssue {
  message: string;
  path: string;
}

interface RemoteInvokeRequest {
  contractFingerprint?: string;
  payload?: unknown;
  trace?: Record<string, boolean | number | string | undefined>;
}

const helperKeys = new Set(["invoke", "route", "sendEvent"]);

const normalizeOrigin = (origin: string): string =>
  origin.replace(/[/]+$/u, "");

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const fingerprint = (value: unknown): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableStringify(value));

  return `sha256:${hasher.digest("hex")}`;
};

const schemaMetadata = (schema: StandardSchemaV1 | undefined): JsonSchema => {
  const schemaWithMetadata = schema as
    | (StandardSchemaV1 & {
        jsonSchema?: JsonSchema;
        "~voke"?: { jsonSchema?: JsonSchema };
      })
    | undefined;

  return (
    schemaWithMetadata?.jsonSchema ??
    schemaWithMetadata?.["~voke"]?.jsonSchema ??
    true
  );
};

export const createFunctionContractArtifact = (
  project: string,
  registry: FunctionRegistry | FunctionRegistryInput
): FunctionContractArtifact => {
  const functions: Record<string, FunctionContractMetadata> = {};

  for (const [key, definition] of Object.entries(registry)) {
    if (helperKeys.has(key) || definition.kind !== "invokable") {
      continue;
    }

    const invokable = definition as InvokableFunctionDefinition;
    functions[key] = {
      input:
        invokable.input === undefined
          ? undefined
          : schemaMetadata(invokable.input),
      output: schemaMetadata(invokable.output),
    };
  }

  const artifact = {
    functions,
    project,
    version: 1,
  } as const;

  return {
    ...artifact,
    fingerprint: fingerprint(artifact),
  };
};

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

const remoteContractEnvName = (project: string): string =>
  `VOKE_REMOTE_${toEnvKey(project)}_CONTRACT_URL`;

const resolveRemoteOrigin = (project: string): string => {
  const origin = Bun.env[remoteOriginEnvName(project)];

  if (origin === undefined || origin.trim() === "") {
    throw new VokeConfigError(
      `Remote Function Registry "${project}" has no runtime target. Configure remotes.${project}.targets for this stage.`
    );
  }

  return normalizeOrigin(origin);
};

const invokeUrl = (project: string, functionName: string): string =>
  `${resolveRemoteOrigin(project)}/_voke/functions/${encodeURIComponent(functionName)}/invoke`;

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
      options: InvokeOptions = {}
    ): Promise<unknown> => {
      const contract = artifact.functions[functionName];

      if (contract === undefined) {
        throw new InvokeError(`Remote Function not found: ${functionName}`, {
          code: "MISSING_FUNCTION",
          functionName,
        });
      }

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

      const response = await fetch(invokeUrl(project, functionName), {
        body: JSON.stringify({
          contractFingerprint: artifact.fingerprint,
          payload,
          trace: options.trace,
        } satisfies RemoteInvokeRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as
        | { data: unknown }
        | { error: { message: string } };

      if (!response.ok) {
        const message =
          "error" in body
            ? body.error.message
            : `Remote Function invocation failed with HTTP ${response.status}`;

        throw new InvokeError(message, {
          code:
            response.status === 404 ? "MISSING_FUNCTION" : "TRANSPORT_FAILED",
          functionName,
          statusCode: response.status,
        });
      }

      const result = "data" in body ? body.data : undefined;
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

const selectedTarget = (
  target: RemoteTarget | undefined
): { contract?: string; origin: string } | undefined => {
  if (typeof target === "string") {
    return { origin: target };
  }

  return target;
};

export const defineRemoteConfig = (
  name: string,
  input: VokeRemoteConfig | VokeRemoteConfigInput,
  stage: string
): VokeRemoteConfig => {
  if ("origin" in input) {
    return input;
  }

  const target = selectedTarget(input.targets[stage] ?? input.targets.local);

  if (target === undefined) {
    throw VokeConfigError.validation([
      {
        message: `missing target for stage "${stage}"`,
        path: `remotes.${name}.targets.${stage}`,
      },
    ]);
  }

  const origin = normalizeOrigin(target.origin);

  return {
    contract: input.contract ?? target.contract ?? `${origin}/_voke/contract`,
    origin,
    out: input.out ?? `src/voke/remotes/${name}.ts`,
  };
};

export const remoteEnvironment = (
  remotes: Record<string, VokeRemoteConfig>
): Record<string, string> => {
  const environment: Record<string, string> = {};

  for (const [name, remote] of Object.entries(remotes)) {
    environment[remoteOriginEnvName(name)] = remote.origin;
    environment[remoteContractEnvName(name)] = remote.contract;
  }

  return environment;
};

const generatedIdentifier = (name: string): string => {
  const value = name.replaceAll(/[^A-Za-z0-9_$]+/gu, "_");
  const identifier = value === "" ? "remote" : value;

  return /^[A-Za-z_$]/u.test(identifier) ? identifier : `_${identifier}`;
};

export const renderRemoteModule = (
  name: string,
  artifact: FunctionContractArtifact
): string =>
  [
    "// @generated by Voke. Do not edit manually.",
    'import { createRemoteFunctions } from "@voke/remote";',
    "",
    `export const ${generatedIdentifier(name)} = createRemoteFunctions(${JSON.stringify(name)}, ${JSON.stringify(artifact, null, 2)} as const);`,
    "",
  ].join("\n");

export interface GenerateRemoteOptions {
  fetch?: typeof fetch;
  names?: string[];
  write?: (path: string, text: string) => Promise<void>;
}

export const generateRemoteModules = async (
  config: VokeConfig,
  options: GenerateRemoteOptions = {}
): Promise<string[]> => {
  const fetcher = options.fetch ?? fetch;
  const writer =
    options.write ??
    (async (path, text) => {
      const directory = path.split("/").slice(0, -1).join("/");

      if (directory !== "") {
        await Bun.$`mkdir -p ${directory}`;
      }

      await Bun.write(path, text);
    });
  const remotes = config.remotes ?? {};
  const names = options.names ?? Object.keys(remotes);
  const outputs: string[] = [];

  for (const name of names) {
    const remote = remotes[name];

    if (remote === undefined) {
      throw new VokeConfigError(`Unknown remote: ${name}`);
    }

    const response = await fetcher(remote.contract);

    if (!response.ok) {
      throw new VokeConfigError(
        `Failed to fetch remote contract for "${name}" from ${remote.contract}: HTTP ${response.status}`
      );
    }

    const body = (await response.json()) as { data?: FunctionContractArtifact };
    const artifact = body.data;

    if (artifact === undefined) {
      throw new VokeConfigError(
        `Remote contract for "${name}" from ${remote.contract} did not return a Voke data envelope`
      );
    }

    await writer(remote.out, renderRemoteModule(name, artifact));
    outputs.push(remote.out);
  }

  return outputs;
};

export const mountDevFunctionEndpoints = (
  gateway: Hono<VokeEnv>,
  options: {
    functions: FunctionRegistry | FunctionRegistryInput;
    project: string;
  }
): void => {
  gateway.get("/_voke/contract", () =>
    json(createFunctionContractArtifact(options.project, options.functions))
  );
  gateway.post("/_voke/functions/:functionName/invoke", async (c) => {
    const artifact = createFunctionContractArtifact(
      options.project,
      options.functions
    );
    const functionName = c.req.param("functionName");
    const body = (await c.req.json()) as RemoteInvokeRequest;

    if (
      body.contractFingerprint !== undefined &&
      body.contractFingerprint !== artifact.fingerprint
    ) {
      return jsonError(
        `Remote Function contract drift for "${options.project}". Run \`voke remote generate ${options.project}\`.`,
        { code: "CONTRACT_DRIFT", status: 409 }
      );
    }

    const definition = options.functions[
      functionName as keyof typeof options.functions
    ] as InvokableFunctionDefinition | undefined;

    if (definition?.kind !== "invokable") {
      return jsonError(`Remote Function not found: ${functionName}`, {
        code: "NOT_FOUND",
        status: 404,
      });
    }

    try {
      return json(
        await invokeRegistryFunction(
          options.functions,
          definition,
          body.payload,
          {
            runtime: "local",
            trace: body.trace,
          }
        )
      );
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), {
        status: error instanceof InvokeError ? 400 : 500,
      });
    }
  });
};
