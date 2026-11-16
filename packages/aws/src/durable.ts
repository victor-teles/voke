import { AsyncLocalStorage } from "node:async_hooks";

import type {
  DurableContext,
  DurableLambdaHandler,
  Duration,
} from "@aws/durable-execution-sdk-js";
import { fn, VokeConfigError } from "voke";
import type {
  AnyFunctionDefinition,
  FunctionSynthesisConfig,
  InvokableFunctionDefinition,
  InvokeContext,
  ProviderInvokeTarget,
  RuntimeVariableCatalog,
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
  VokeModelProviderExtensionRecord,
} from "voke";

import { runLocalDurableExecution } from "./durable-local";
import { lambdaFunctionRecordType } from "./lambda-settings";
import type { AwsLambdaDurableOptions } from "./lambda-settings";
import { toEnvKey } from "./resources";

export type { DurableContext, Duration as DurableDuration };

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

/** The alias every deployed Durable Function is invoked through. */
export const durableAliasName = "live";

/** The variable that names the qualified Lambda a Durable Function is started through. */
export const durableInvokeTargetVariable = (key: string): string =>
  `VOKE_INVOKE_TARGET_${toEnvKey(key)}`;

/** The handler context of a Durable Function: the Invoke Context plus the SDK's DurableContext. */
export type DurableInvokeContext<
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResource extends string = string,
> = InvokeContext<TVariables, TResource> & {
  /** The AWS durable execution SDK context: `step`, `wait`, `waitForCallback`, `invoke`, ... */
  readonly durable: DurableContext;
};

export type DurableFunctionHandler<
  TPayload,
  TResult,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResource extends string = string,
> = (
  payload: TPayload,
  context: DurableInvokeContext<TVariables, TResource>
) => TResult | Promise<TResult>;

interface DurableFunctionInputBase<
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> {
  /**
   * How long one execution may run in total, across every wait and replay. Required: Lambda
   * allows up to 366 days, and that is the cost ceiling of a stuck execution.
   */
  executionTimeout: Duration;
  name?: string;
  /** Days Lambda keeps a finished execution's history (1-90). Default 14. */
  retentionDays?: number;
  /** Resource Links: the resource keys this Function reads through `context.resource`. */
  resources?: TResources;
  synthesis?: FunctionSynthesisConfig;
  variables?: TVariables;
}

export interface DurableFunctionWithInputDefinitionInput<
  TInputSchema extends AnyStandardSchema,
  TOutputSchema extends AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> extends DurableFunctionInputBase<TVariables, TResources> {
  handler: DurableFunctionHandler<
    StandardSchemaOutput<TInputSchema>,
    StandardSchemaInput<TOutputSchema>,
    TVariables,
    TResources[number]
  >;
  input: TInputSchema;
  output: TOutputSchema;
}

export interface DurableZeroInputFunctionDefinitionInput<
  TOutputSchema extends AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> extends DurableFunctionInputBase<TVariables, TResources> {
  handler: DurableFunctionHandler<
    undefined,
    StandardSchemaInput<TOutputSchema>,
    TVariables,
    TResources[number]
  >;
  output: TOutputSchema;
}

type AnyDurableHandler = (
  payload: unknown,
  context: DurableInvokeContext
) => unknown;

type StoredHandler = (payload: unknown, context: InvokeContext) => unknown;

// The stored handlers of durable(...) Functions. createFunctions copies definitions, but the
// handler keeps its identity, so it identifies a Durable Function in any registry.
const durableHandlers = new WeakSet<StoredHandler>();

interface AmbientDurableExecution {
  readonly context: DurableContext;
  readonly handler: StoredHandler;
}

// Set by the deployed Lambda handler around one durable invocation of a Function.
const ambientExecution = new AsyncLocalStorage<AmbientDurableExecution>();

const storedHandlerOf = (
  definition: AnyFunctionDefinition
): StoredHandler | undefined =>
  definition.kind === "invokable" && typeof definition.handler === "function"
    ? (definition.handler as StoredHandler)
    : undefined;

/** Whether `definition` was declared with `durable(...)`. */
export const isDurableFunction = (
  definition: AnyFunctionDefinition
): boolean => {
  const handler = storedHandlerOf(definition);

  return handler !== undefined && durableHandlers.has(handler);
};

const secondsPerUnit = {
  days: 86_400,
  hours: 3600,
  minutes: 60,
  seconds: 1,
} as const;

const durationSeconds = (duration: unknown): number => {
  if (typeof duration !== "object" || duration === null) {
    throw new VokeConfigError(
      "durable(...) requires executionTimeout, for example { hours: 24 }: the longest one execution may run in total."
    );
  }

  let total = 0;

  for (const [unit, factor] of Object.entries(secondsPerUnit)) {
    const value = (duration as Record<string, unknown>)[unit];

    if (value === undefined) {
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new VokeConfigError(
        `durable(...) executionTimeout.${unit} must be a non-negative number; received ${JSON.stringify(value)}.`
      );
    }

    total += value * factor;
  }

  if (total <= 0) {
    throw new VokeConfigError(
      "durable(...) executionTimeout must be longer than zero, for example { hours: 24 }."
    );
  }

  if (!Number.isInteger(total)) {
    throw new VokeConfigError(
      `durable(...) executionTimeout must add up to a whole number of seconds; received ${total}.`
    );
  }

  return total;
};

const withDurableRecord = (
  synthesis: FunctionSynthesisConfig | undefined,
  durableOptions: AwsLambdaDurableOptions
): FunctionSynthesisConfig => {
  const existing: VokeModelProviderExtensionRecord | undefined =
    synthesis?.provider?.aws;

  return {
    ...synthesis,
    provider: {
      ...synthesis?.provider,
      aws: {
        // A non-Lambda record is kept as given, so model validation reports its type.
        properties: { ...existing?.properties, durable: { ...durableOptions } },
        type: existing?.type ?? lambdaFunctionRecordType,
      },
    },
  };
};

export function durable<
  const TInputSchema extends AnyStandardSchema,
  const TOutputSchema extends AnyStandardSchema,
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: DurableFunctionWithInputDefinitionInput<
    TInputSchema,
    TOutputSchema,
    TVariables,
    TResources
  >
): InvokableFunctionDefinition<string, TInputSchema, TOutputSchema, TVariables>;
export function durable<
  const TOutputSchema extends AnyStandardSchema,
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: DurableZeroInputFunctionDefinitionInput<
    TOutputSchema,
    TVariables,
    TResources
  >
): InvokableFunctionDefinition<string, undefined, TOutputSchema, TVariables>;
/**
 * A Function that runs as an AWS Lambda durable function: its handler receives
 * `context.durable` (the SDK's DurableContext) and can checkpoint `step`s, `wait` and pause for
 * callbacks. It is an invokable Function: start it with `functions.invoke`.
 */
export function durable(
  definition:
    | DurableFunctionWithInputDefinitionInput<
        AnyStandardSchema,
        AnyStandardSchema
      >
    | DurableZeroInputFunctionDefinitionInput<AnyStandardSchema>
): AnyFunctionDefinition {
  const executionTimeoutSeconds = durationSeconds(definition.executionTimeout);
  const userHandler = definition.handler as AnyDurableHandler;

  const storedHandler: StoredHandler = async (payload, context) => {
    const ambient = ambientExecution.getStore();

    if (ambient?.handler === storedHandler) {
      // Leave the ambient execution so a nested invoke of this Function starts a new one.
      return await ambientExecution.exit(() =>
        userHandler(payload, { ...context, durable: ambient.context })
      );
    }

    return await runLocalDurableExecution(
      payload,
      async (durableContext) =>
        await userHandler(payload, { ...context, durable: durableContext })
    );
  };

  durableHandlers.add(storedHandler);

  return fn({
    handler: storedHandler as never,
    ...("input" in definition ? { input: definition.input } : {}),
    ...(definition.name === undefined ? {} : { name: definition.name }),
    output: definition.output,
    ...(definition.resources === undefined
      ? {}
      : { resources: definition.resources }),
    synthesis: withDurableRecord(definition.synthesis, {
      executionTimeoutSeconds,
      ...(definition.retentionDays === undefined
        ? {}
        : { retentionDays: definition.retentionDays }),
    }),
    ...(definition.variables === undefined
      ? {}
      : { variables: definition.variables }),
  } as never) as AnyFunctionDefinition;
}

/**
 * The Provider invoke target for a Durable Function: its qualified deployed name, read from the
 * variable synthesis sets. None locally (the variable is absent) or for other Functions. The
 * Function's own Lambda handler invokes it with `runtime: "local"`, which skips this target.
 */
export const durableInvokeTarget = ({
  definition,
  key,
}: {
  definition: AnyFunctionDefinition;
  key: string;
}): ProviderInvokeTarget | undefined => {
  if (!isDurableFunction(definition)) {
    return undefined;
  }

  const functionName = process.env[durableInvokeTargetVariable(key)];

  return functionName === undefined || functionName === ""
    ? undefined
    : { functionName };
};

/**
 * The deployed Lambda handler of a Durable Function. Each durable invocation runs `invoke` (the
 * Function Registry's `functions.invoke`) with the execution's DurableContext as the ambient
 * context, so payload and result validation run exactly as they do locally.
 */
export const createDurableLambdaHandler = (
  definition: AnyFunctionDefinition,
  invoke: (event: unknown) => Promise<unknown>
): ((event: unknown, context?: unknown) => Promise<unknown>) => {
  const handler = storedHandlerOf(definition);

  if (handler === undefined || !durableHandlers.has(handler)) {
    throw new VokeConfigError(
      "createDurableLambdaHandler expects a Function declared with durable(...)."
    );
  }

  // The SDK loads on the first invocation, so non-durable cold starts never evaluate it.
  const createHandler = async (): Promise<DurableLambdaHandler> => {
    const { withDurableExecution } =
      await import("@aws/durable-execution-sdk-js");

    return withDurableExecution(
      async (input: unknown, durableContext) =>
        await ambientExecution.run(
          { context: durableContext, handler },
          async () => await invoke(input)
        )
    );
  };
  let durableHandler: Promise<DurableLambdaHandler> | undefined;

  return async (event, context) => {
    durableHandler ??= createHandler();
    const run = await durableHandler;

    return await run(event as never, context as never);
  };
};
