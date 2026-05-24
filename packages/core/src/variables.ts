import { toEnvKey } from "./env-key";
import { VokeRuntimeVariableError } from "./errors";

export { VokeRuntimeVariableError };

export type RuntimeVariableSource = Readonly<
  {
    kind: string;
  } & Record<string, string | number | boolean | undefined>
>;

export interface RuntimeVariableDescriptor {
  readonly kind: "runtimeVariable";
  readonly options: RuntimeVariableOptions;
  readonly provider: string;
  readonly source: RuntimeVariableSource;
}

export interface RuntimeVariableOptions {
  readonly cache?: boolean | { readonly ttlSeconds: number };
  readonly load?: "beforeHandler" | "lazy";
  readonly optional?: boolean;
}

export type RuntimeVariableCatalog = Record<string, RuntimeVariableDescriptor>;

export type RuntimeVariableProviderLoadResult =
  | { readonly status: "found"; readonly value: string }
  | { readonly status: "missing" };

export interface RuntimeVariableProviderLoadContext {
  readonly functionKey: string;
  readonly signal?: AbortSignal;
  readonly source: RuntimeVariableSource;
  readonly variableKey: string;
}

export interface RuntimeVariableProviderInput {
  readonly id: string;
  readonly load: (
    context: RuntimeVariableProviderLoadContext
  ) =>
    | Promise<RuntimeVariableProviderLoadResult>
    | RuntimeVariableProviderLoadResult;
}

export type RuntimeVariableProvider = RuntimeVariableProviderInput;

export interface StandardSchemaIssue {
  message: string;
  path?: readonly PropertyKey[];
}

export type StandardSchemaResult<TOutput> =
  | { data: TOutput; success: true }
  | { issues: readonly StandardSchemaIssue[]; success: false };

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly vendor: string;
    readonly version: 1;
    validate(
      value: TInput
    ): StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
    readonly types?: {
      readonly input: TInput;
      readonly output: TOutput;
    };
  };
}

type StandardSchemaOutput<TSchema> = TSchema extends {
  readonly "~standard": { readonly types: { output: infer TOutput } };
}
  ? TOutput
  : TSchema extends {
        readonly "~standard": {
          validate(
            value: unknown
          ):
            | StandardSchemaResult<infer TOutput>
            | Promise<StandardSchemaResult<infer TOutput>>;
        };
      }
    ? TOutput
    : never;

type RuntimeVariableValue<TDescriptor> = TDescriptor extends {
  readonly options: { readonly optional: true };
}
  ? string | undefined
  : string;

type RuntimeVariableJsonValue<TDescriptor, TValue> = TDescriptor extends {
  readonly options: { readonly optional: true };
}
  ? TValue | undefined
  : TValue;

export interface RuntimeVariableHandle<
  TDescriptor = RuntimeVariableDescriptor,
> {
  json: {
    (): Promise<RuntimeVariableJsonValue<TDescriptor, unknown>>;
    <TSchema extends StandardSchemaV1>(
      schema: TSchema
    ): Promise<
      RuntimeVariableJsonValue<TDescriptor, StandardSchemaOutput<TSchema>>
    >;
  };
  refresh: () => Promise<RuntimeVariableHandle<TDescriptor>>;
  text: () => Promise<RuntimeVariableValue<TDescriptor>>;
}

export interface RuntimeVariableOverrides {
  readonly defaults?: Record<string, string>;
  readonly functions?: Record<string, Record<string, string>>;
}

export type RuntimeVariableHandles<TVariables extends RuntimeVariableCatalog> =
  {
    readonly [TKey in keyof TVariables]-?: RuntimeVariableHandle<
      TVariables[TKey]
    >;
  };

interface RuntimeVariableCacheEntry {
  completed?: {
    loadedAt: number;
    value: string | undefined;
  };
  inFlight?: Promise<string | undefined>;
}

export type RuntimeVariableCache = Map<string, RuntimeVariableCacheEntry>;

export interface CreateRuntimeVariablesOptions<
  TVariables extends RuntimeVariableCatalog,
> {
  readonly clock?: () => number;
  readonly cache?: RuntimeVariableCache;
  readonly env?: Record<string, string | undefined>;
  readonly functionKey: string;
  readonly overrides?: RuntimeVariableOverrides;
  readonly providers: readonly RuntimeVariableProvider[];
  readonly signal?: AbortSignal;
  readonly variables: TVariables;
}

const freezeSource = <TSource extends RuntimeVariableSource>(
  source: TSource
): Readonly<TSource> => Object.freeze({ ...source });

const sourceLabel = (provider: string, source: RuntimeVariableSource): string =>
  `${provider} ${source.kind} "${String(source.id ?? source.kind)}"`;

const validateOverrideValues = (
  overrides: RuntimeVariableOverrides | undefined
): void => {
  for (const [key, value] of Object.entries(overrides?.defaults ?? {})) {
    if (typeof value !== "string") {
      throw new VokeRuntimeVariableError(
        `Runtime Variable override "${key}" must be a string.`
      );
    }
  }

  for (const functionOverrides of Object.values(overrides?.functions ?? {})) {
    for (const [key, value] of Object.entries(functionOverrides)) {
      if (typeof value !== "string") {
        throw new VokeRuntimeVariableError(
          `Runtime Variable override "${key}" must be a string.`
        );
      }
    }
  }
};

const variableEnvName = (variableKey: string, functionKey?: string): string => {
  const suffix =
    functionKey === undefined
      ? toEnvKey(variableKey)
      : `${toEnvKey(functionKey)}_${toEnvKey(variableKey)}`;

  return `VOKE_VARIABLE_${suffix}`;
};

const resolveOverride = (
  functionKey: string,
  variableKey: string,
  overrides: RuntimeVariableOverrides | undefined
): string | undefined =>
  overrides?.functions?.[functionKey]?.[variableKey] ??
  overrides?.defaults?.[variableKey];

const resolveEnvironment = (
  functionKey: string,
  variableKey: string,
  env: Record<string, string | undefined>
): string | undefined =>
  env[variableEnvName(variableKey, functionKey)] ??
  env[variableEnvName(variableKey)];

export const createVariableSource = <
  const TSource extends RuntimeVariableSource,
>(
  provider: string,
  source: TSource,
  options: RuntimeVariableOptions = {}
): RuntimeVariableDescriptor & { readonly source: Readonly<TSource> } =>
  Object.freeze({
    kind: "runtimeVariable",
    options: Object.freeze({ ...options }),
    provider,
    source: freezeSource(source),
  });

export const createVariableProvider = (
  provider: RuntimeVariableProviderInput
): RuntimeVariableProvider => {
  if (provider.id.trim() === "") {
    throw new VokeRuntimeVariableError(
      "Runtime Variable provider id must not be empty."
    );
  }

  if (typeof provider.load !== "function") {
    throw new VokeRuntimeVariableError(
      `Runtime Variable provider "${provider.id}" must define a load function.`
    );
  }

  return Object.freeze({
    id: provider.id,
    load: provider.load,
  });
};

const createProviderMap = (
  providers: readonly RuntimeVariableProvider[]
): Map<string, RuntimeVariableProvider> => {
  const providerMap = new Map<string, RuntimeVariableProvider>();

  for (const provider of providers) {
    if (providerMap.has(provider.id)) {
      throw new VokeRuntimeVariableError(
        `Runtime Variable provider "${provider.id}" is registered more than once.`
      );
    }

    providerMap.set(provider.id, provider);
  }

  return providerMap;
};

const validateRegisteredProviders = (
  functionKey: string,
  variables: RuntimeVariableCatalog,
  providers: Map<string, RuntimeVariableProvider>
): void => {
  for (const [variableKey, descriptor] of Object.entries(variables)) {
    if (!providers.has(descriptor.provider)) {
      throw new VokeRuntimeVariableError(
        `Runtime variable "${variableKey}" for Function "${functionKey}" references provider "${descriptor.provider}", but no Runtime Variable provider with that id is registered.`
      );
    }
  }
};

const parseJson = (input: string, variableKey: string, functionKey: string) => {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new VokeRuntimeVariableError(
      `Runtime variable "${variableKey}" for Function "${functionKey}" is not valid JSON.`,
      { cause: error }
    );
  }
};

const formatSchemaIssue = (issue: StandardSchemaIssue): string =>
  issue.path === undefined || issue.path.length === 0
    ? issue.message
    : `${issue.path.map(String).join(".")}: ${issue.message}`;

const parseWithSchema = async <TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
  variableKey: string,
  functionKey: string
): Promise<StandardSchemaOutput<TSchema>> => {
  try {
    const result = await schema["~standard"].validate(value);

    if (result.success) {
      return result.data as StandardSchemaOutput<TSchema>;
    }

    throw new VokeRuntimeVariableError(
      `Runtime variable "${variableKey}" for Function "${functionKey}" failed schema validation: ${result.issues.map(formatSchemaIssue).join("; ")}.`,
      {
        issues: result.issues.map((issue) => ({
          message: issue.message,
          path: issue.path?.map(String).join(".") ?? "",
        })),
      }
    );
  } catch (error) {
    if (error instanceof VokeRuntimeVariableError) {
      throw error;
    }

    throw new VokeRuntimeVariableError(
      `Runtime variable "${variableKey}" for Function "${functionKey}" failed schema validation.`,
      { cause: error }
    );
  }
};

const shouldUseCompletedCache = (
  descriptor: RuntimeVariableDescriptor
): boolean => descriptor.options.cache !== false;

const completedCacheIsFresh = (
  descriptor: RuntimeVariableDescriptor,
  loadedAt: number,
  now: number
): boolean => {
  if (descriptor.options.cache === false) {
    return false;
  }

  if (
    typeof descriptor.options.cache === "object" &&
    descriptor.options.cache !== null
  ) {
    return now - loadedAt <= descriptor.options.cache.ttlSeconds * 1000;
  }

  return true;
};

const runtimeVariableMetadata = Symbol("voke.runtimeVariables");

interface RuntimeVariableHandleMetadata {
  loadBeforeHandler: () => Promise<void>;
}

export const createRuntimeVariableCache = (): RuntimeVariableCache => new Map();

export const createRuntimeVariables = <
  const TVariables extends RuntimeVariableCatalog,
>(
  options: CreateRuntimeVariablesOptions<TVariables>
): RuntimeVariableHandles<TVariables> => {
  validateOverrideValues(options.overrides);

  const providers = createProviderMap(options.providers);
  validateRegisteredProviders(
    options.functionKey,
    options.variables,
    providers
  );
  const handles = {} as Record<string, RuntimeVariableHandle>;
  const env = options.env ?? Bun.env;
  const clock = options.clock ?? (() => Date.now());
  const cache = options.cache ?? createRuntimeVariableCache();

  for (const [variableKey, descriptor] of Object.entries(options.variables)) {
    const cacheKey = `${options.functionKey}\0${variableKey}`;
    const state = cache.get(cacheKey) ?? {};
    cache.set(cacheKey, state);

    const loadValue = async (): Promise<string | undefined> => {
      const override = resolveOverride(
        options.functionKey,
        variableKey,
        options.overrides
      );

      if (override !== undefined) {
        return override;
      }

      const environmentValue = resolveEnvironment(
        options.functionKey,
        variableKey,
        env
      );

      if (environmentValue !== undefined) {
        return environmentValue;
      }

      const provider = providers.get(descriptor.provider);

      if (provider === undefined) {
        throw new VokeRuntimeVariableError(
          `Runtime variable "${variableKey}" for Function "${options.functionKey}" references provider "${descriptor.provider}", but no Runtime Variable provider with that id is registered.`
        );
      }

      let result: RuntimeVariableProviderLoadResult;

      try {
        result = await provider.load({
          functionKey: options.functionKey,
          signal: options.signal,
          source: descriptor.source,
          variableKey,
        });
      } catch (error) {
        throw new VokeRuntimeVariableError(
          `Runtime variable "${variableKey}" for Function "${options.functionKey}" could not be loaded from ${sourceLabel(descriptor.provider, descriptor.source)}.`,
          { cause: error }
        );
      }

      if (result.status === "found") {
        if (typeof result.value !== "string") {
          throw new VokeRuntimeVariableError(
            `Runtime variable "${variableKey}" for Function "${options.functionKey}" provider "${descriptor.provider}" returned a non-string value.`
          );
        }

        return result.value;
      }

      if (descriptor.options.optional === true) {
        return;
      }

      throw new VokeRuntimeVariableError(
        `Runtime variable "${variableKey}" for Function "${options.functionKey}" could not be resolved from ${sourceLabel(descriptor.provider, descriptor.source)}.`
      );
    };

    const readRawValue = async (): Promise<string | undefined> => {
      if (
        state.completed !== undefined &&
        completedCacheIsFresh(descriptor, state.completed.loadedAt, clock())
      ) {
        return state.completed.value;
      }

      if (state.inFlight !== undefined) {
        return await state.inFlight;
      }

      state.inFlight = (async () => {
        try {
          const value = await loadValue();

          if (shouldUseCompletedCache(descriptor)) {
            state.completed = { loadedAt: clock(), value };
          }

          return value;
        } finally {
          state.inFlight = undefined;
        }
      })();

      return await state.inFlight;
    };

    const handle: RuntimeVariableHandle = {
      json: (async (schema?: StandardSchemaV1) => {
        const value = await handle.text();

        if (value === undefined) {
          return;
        }

        const parsed = parseJson(value, variableKey, options.functionKey);

        return schema === undefined
          ? parsed
          : await parseWithSchema(
              schema,
              parsed,
              variableKey,
              options.functionKey
            );
      }) as RuntimeVariableHandle["json"],
      refresh: async () => {
        state.completed = undefined;
        await readRawValue();

        return handle;
      },
      text: async () => (await readRawValue()) as never,
    };

    Object.defineProperty(handle, runtimeVariableMetadata, {
      value: {
        loadBeforeHandler: async () => {
          if (descriptor.options.load === "beforeHandler") {
            await handle.text();
          }
        },
      } satisfies RuntimeVariableHandleMetadata,
    });

    handles[variableKey] = handle;
  }

  return Object.freeze(handles) as RuntimeVariableHandles<TVariables>;
};

export const loadRuntimeVariablesBeforeHandler = async (
  handles: RuntimeVariableHandles<RuntimeVariableCatalog>
): Promise<void> => {
  await Promise.all(
    Object.values(handles).map(async (handle) => {
      const metadata = (
        handle as RuntimeVariableHandle & {
          readonly [runtimeVariableMetadata]?: RuntimeVariableHandleMetadata;
        }
      )[runtimeVariableMetadata];

      await metadata?.loadBeforeHandler();
    })
  );
};
