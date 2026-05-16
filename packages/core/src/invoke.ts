export type InvokeMode = "sync" | "async";
export type InvokeRuntime = "local" | "aws";

export type InvokeTrace = Record<string, string | number | boolean | undefined>;

export interface InvokeContext {
  functionName: string;
  trace: InvokeTrace;
}

export interface AsyncInvokeResult {
  accepted: true;
  requestId?: string;
}

export type FunctionHandler<TPayload, TResult> = (
  payload: TPayload,
  context: InvokeContext
) => TResult | Promise<TResult>;

export interface FunctionDefinition<
  TName extends string = string,
  TPayload = unknown,
  TResult = unknown,
> {
  name: TName;
  validatePayload?: (payload: TPayload) => void;
  handler(
    payload: TPayload,
    context: InvokeContext
  ): TResult | Promise<TResult>;
}

export type FunctionRegistry = Record<
  string,
  FunctionDefinition<string, never, unknown>
>;

export interface InvokeRequest<TPayload = unknown> {
  functionName: string;
  invocationType: "RequestResponse" | "Event";
  payload: {
    payload: TPayload;
    trace: InvokeTrace;
  };
}

export interface InvokeTransportResponse<TResult = unknown> {
  statusCode?: number;
  payload?: TResult | { data: TResult };
  requestId?: string;
}

export interface InvokeTransport {
  invoke: <TPayload>(
    request: InvokeRequest<TPayload>
  ) => Promise<InvokeTransportResponse<unknown>>;
}

export interface InvokeOptions {
  mode?: InvokeMode;
  runtime?: InvokeRuntime;
  trace?: InvokeTrace;
  retries?: number;
  timeoutMs?: number;
  transport?: InvokeTransport;
}

type InferPayload<TDefinition> =
  TDefinition extends FunctionDefinition<string, infer TPayload, infer _TResult>
    ? TPayload
    : never;

type InferResult<TDefinition> =
  TDefinition extends FunctionDefinition<string, infer _TPayload, infer TResult>
    ? TResult
    : never;

type InvokeResult<TResult, TOptions> = TOptions extends { mode: "async" }
  ? AsyncInvokeResult
  : TResult;

const localFunctions = new Map<
  string,
  FunctionDefinition<string, never, unknown>
>();
const traceStack: InvokeTrace[] = [];

const currentTrace = (): InvokeTrace => traceStack.at(-1) ?? {};

const resolveTrace = (options: InvokeOptions): InvokeTrace => ({
  ...currentTrace(),
  ...options.trace,
});

const resolveRuntime = (options: InvokeOptions): InvokeRuntime => {
  if (options.runtime !== undefined) {
    return options.runtime;
  }

  return Bun.env.VOKE_INVOKE_RUNTIME === "aws" ? "aws" : "local";
};

const validatePayload = <TPayload>(
  definition: FunctionDefinition<string, TPayload, unknown>,
  payload: TPayload
): void => {
  try {
    definition.validatePayload?.(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Invalid payload for ${definition.name}: ${message}`, {
      cause: error,
    });
  }
};

const sleepAndThrow = async (timeoutMs: number, message: string) => {
  await Bun.sleep(timeoutMs);
  throw new Error(message);
};

const withTimeout = async <TResult>(
  value: TResult | Promise<TResult>,
  timeoutMs: number | undefined,
  message: string
): Promise<TResult> => {
  if (timeoutMs === undefined) {
    return await value;
  }

  return Promise.race([value, sleepAndThrow(timeoutMs, message)]);
};

const runWithRetries = async <TResult>(
  operation: () => Promise<TResult>,
  options: InvokeOptions
): Promise<TResult> => {
  const retries = options.retries ?? 0;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      attempt += 1;

      if (attempt > retries) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const runLocalFunction = <TPayload, TResult>(
  definition: FunctionDefinition<string, TPayload, TResult>,
  payload: TPayload,
  options: InvokeOptions
): Promise<TResult> =>
  withTimeout(
    definition.handler(payload, {
      functionName: definition.name,
      trace: resolveTrace(options),
    }),
    options.timeoutMs,
    `invoke("${definition.name}") timed out after ${options.timeoutMs}ms`
  );

const runQueuedLocalFunction = async <TPayload, TResult>(
  definition: FunctionDefinition<string, TPayload, TResult>,
  payload: TPayload,
  options: InvokeOptions
): Promise<void> => {
  try {
    await runWithRetries(
      () => runLocalFunction(definition, payload, options),
      options
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
};

const unwrapPayload = <TResult>(
  payload: TResult | { data: TResult } | undefined
): TResult => {
  if (
    payload !== undefined &&
    typeof payload === "object" &&
    payload !== null &&
    "data" in payload
  ) {
    return (payload as { data: TResult }).data;
  }

  return payload as TResult;
};

const invokeAws = async <TPayload, TResult>(
  functionName: string,
  payload: TPayload,
  options: InvokeOptions
): Promise<TResult> => {
  const { transport } = options;

  if (transport === undefined) {
    throw new Error("AWS invoke runtime requires an InvokeTransport");
  }

  const response = await runWithRetries(
    () =>
      withTimeout(
        transport.invoke<TPayload>({
          functionName,
          invocationType:
            options.mode === "async" ? "Event" : "RequestResponse",
          payload: {
            payload,
            trace: resolveTrace(options),
          },
        }),
        options.timeoutMs,
        `invoke("${functionName}") timed out after ${options.timeoutMs}ms`
      ),
    options
  );

  if (options.mode === "async") {
    return {
      accepted: true,
      ...(response.requestId === undefined
        ? {}
        : { requestId: response.requestId }),
    } as TResult;
  }

  if (response.statusCode !== undefined && response.statusCode >= 400) {
    throw new Error(
      `invoke("${functionName}") failed with status ${response.statusCode}`
    );
  }

  return unwrapPayload(response.payload) as TResult;
};

const invokeWithDefinition = <TPayload, TResult>(
  definition: FunctionDefinition<string, TPayload, TResult> | undefined,
  payload: TPayload,
  options: InvokeOptions = {}
): Promise<TResult | AsyncInvokeResult> => {
  if (definition === undefined) {
    throw new Error("Cannot invoke an undefined function definition");
  }

  validatePayload(definition, payload);
  const invokeOptions = {
    ...options,
    trace: resolveTrace(options),
  };

  if (options.mode === "async") {
    void runQueuedLocalFunction(definition, payload, invokeOptions);

    return Promise.resolve({ accepted: true });
  }

  return runWithRetries(
    () => runLocalFunction(definition, payload, invokeOptions),
    invokeOptions
  );
};

export const defineFunction = <TName extends string, TPayload, TResult>(
  definition: FunctionDefinition<TName, TPayload, TResult>
): FunctionDefinition<TName, TPayload, TResult> => definition;

export const createFunctionRegistry = <TRegistry extends FunctionRegistry>(
  registry: TRegistry
): TRegistry => registry;

export const createInvoker =
  <TRegistry extends FunctionRegistry>(
    registry: TRegistry
  ): (<
    TName extends keyof TRegistry & string,
    TOptions extends InvokeOptions | undefined = undefined,
  >(
    functionName: TName,
    payload: InferPayload<TRegistry[TName]>,
    options?: TOptions
  ) => Promise<
    InvokeResult<Awaited<InferResult<TRegistry[TName]>>, TOptions>
  >) =>
  async <
    TName extends keyof TRegistry & string,
    TOptions extends InvokeOptions | undefined = undefined,
  >(
    functionName: TName,
    payload: InferPayload<TRegistry[TName]>,
    options?: TOptions
  ): Promise<
    InvokeResult<Awaited<InferResult<TRegistry[TName]>>, TOptions>
  > => {
    const definition = registry[functionName] as unknown as FunctionDefinition<
      string,
      InferPayload<TRegistry[TName]>,
      InferResult<TRegistry[TName]>
    >;
    const result = await invokeWithDefinition(definition, payload, options);

    return result as InvokeResult<
      Awaited<InferResult<TRegistry[TName]>>,
      TOptions
    >;
  };

export const registerLocalFunction = <TName extends string, TPayload, TResult>(
  definition: FunctionDefinition<TName, TPayload, TResult>
): FunctionDefinition<TName, TPayload, TResult> => {
  localFunctions.set(
    definition.name,
    definition as FunctionDefinition<string, never, unknown>
  );

  return definition;
};

export const resetLocalFunctions = (): void => {
  localFunctions.clear();
};

export const withInvokeTrace = async <TResult>(
  trace: InvokeTrace,
  operation: () => TResult | Promise<TResult>
): Promise<TResult> => {
  traceStack.push({ ...currentTrace(), ...trace });

  try {
    return await operation();
  } finally {
    traceStack.pop();
  }
};

export const invoke = <TPayload, TResult>(
  functionName: string,
  payload: TPayload,
  options: InvokeOptions = {}
): Promise<TResult> => {
  if (resolveRuntime(options) === "aws") {
    return invokeAws<TPayload, TResult>(functionName, payload, options);
  }

  const definition = localFunctions.get(functionName);

  if (definition === undefined) {
    throw new Error(
      `No local function registered for invoke("${functionName}")`
    );
  }

  return invokeWithDefinition(
    definition as unknown as FunctionDefinition<string, TPayload, TResult>,
    payload,
    options
  ) as Promise<TResult>;
};
