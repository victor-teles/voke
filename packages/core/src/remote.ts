import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Hono } from "hono";

import type { VokeConfig } from "./config";
import type { VokeEnv } from "./context";
import { toEnvKey } from "./env-key";
import { VokeConfigError } from "./errors";
import { json, jsonError } from "./http";
import type {
  FunctionRegistry,
  FunctionRegistryInput,
  InvokableFunctionDefinition,
  StandardSchemaV1,
} from "./invoke";
import { InvokeError, invokeRegistryFunction } from "./invoke";
import { sha256Hex } from "./runtime-env";
import { readJsonSchema } from "./standard-schema";

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

const fingerprint = (value: unknown): string =>
  `sha256:${sha256Hex(stableStringify(value))}`;

type JsonSchemaObject = Exclude<JsonSchema, boolean>;
type JsonSchemaTypeName = NonNullable<JsonSchemaObject["type"]>;

const jsonSchemaTypeNames = new Set<unknown>([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
] satisfies JsonSchemaTypeName[]);

// Keywords whose meaning the subset cannot keep: dropping them would make the schema stricter
// or looser than the source, so the whole node becomes `true` instead.
const inexpressibleKeywords = [
  "$ref",
  "allOf",
  "anyOf",
  "if",
  "not",
  "oneOf",
] as const;

const isJsonPrimitive = (value: unknown): value is JsonPrimitive =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isExpressible = (node: Record<string, unknown>): boolean =>
  !inexpressibleKeywords.some((keyword) => keyword in node) &&
  (node.type === undefined || jsonSchemaTypeNames.has(node.type)) &&
  (node.const === undefined || isJsonPrimitive(node.const)) &&
  (node.enum === undefined ||
    (Array.isArray(node.enum) && node.enum.every(isJsonPrimitive)));

/**
 * Narrows a JSON Schema to the keywords the Function Contract Artifact keeps
 * (`additionalProperties`, `const`, `enum`, `items`, `properties`, `required`, a single `type`).
 * Other annotations and constraints are dropped; a node using `anyOf`, `oneOf`, `allOf`, `not`,
 * `$ref`, `if` or a `type` array becomes `true`, as does anything that is not a schema.
 */
export const toContractJsonSchema = (schema: unknown): JsonSchema => {
  if (typeof schema === "boolean") {
    return schema;
  }

  if (!isRecord(schema) || !isExpressible(schema)) {
    return true;
  }

  const narrowed: {
    -readonly [TKey in keyof JsonSchemaObject]: JsonSchemaObject[TKey];
  } = {};

  if (
    typeof schema.additionalProperties === "boolean" ||
    isRecord(schema.additionalProperties)
  ) {
    narrowed.additionalProperties = toContractJsonSchema(
      schema.additionalProperties
    );
  }

  if (schema.const !== undefined) {
    narrowed.const = schema.const as JsonPrimitive;
  }

  if (schema.enum !== undefined) {
    narrowed.enum = schema.enum as JsonPrimitive[];
  }

  if (schema.items !== undefined) {
    narrowed.items = toContractJsonSchema(schema.items);
  }

  if (isRecord(schema.properties)) {
    narrowed.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        toContractJsonSchema(value),
      ])
    );
  }

  if (
    Array.isArray(schema.required) &&
    schema.required.every((key) => typeof key === "string")
  ) {
    narrowed.required = schema.required as string[];
  }

  if (schema.type !== undefined) {
    narrowed.type = schema.type as JsonSchemaTypeName;
  }

  return narrowed;
};

const schemaMetadata = (
  schema: StandardSchemaV1 | undefined,
  io: "input" | "output"
): JsonSchema => toContractJsonSchema(readJsonSchema(schema, io));

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
          : schemaMetadata(invokable.input, "input"),
      output: schemaMetadata(invokable.output, "output"),
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

const remoteOriginEnvName = (project: string): string =>
  `VOKE_REMOTE_${toEnvKey(project)}_ORIGIN`;

const remoteContractEnvName = (project: string): string =>
  `VOKE_REMOTE_${toEnvKey(project)}_CONTRACT_URL`;

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
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
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

// A body that is not JSON, or JSON that is not an object, answers undefined.
const readInvokeRequest = async (request: {
  json: () => Promise<unknown>;
}): Promise<RemoteInvokeRequest | undefined> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return undefined;
  }

  return isRecord(body) ? (body as RemoteInvokeRequest) : undefined;
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
    const body = await readInvokeRequest(c.req);

    if (body === undefined) {
      return jsonError(
        "The Dev Function Invoke Endpoint expects a JSON object body",
        { code: "BAD_REQUEST", status: 400 }
      );
    }

    const artifact = createFunctionContractArtifact(
      options.project,
      options.functions
    );
    const functionName = c.req.param("functionName");

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
