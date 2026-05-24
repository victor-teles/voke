import type { Context, Hono, MiddlewareHandler } from "hono";

import packageJson from "../package.json";
import type {
  AuthorizerRegistryInput,
  RequestAuthorizerFunctionDefinition,
  RequestAuthorizerHandler,
} from "./authorizers";
import { createAwsLambdaInvokeTransport } from "./aws-lambda-invoke-transport";
import type { VokeNodeRuntime } from "./config";
import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import { json, jsonError } from "./http";

export type InvokeMode = "sync" | "async";
export type InvokeRuntime = "local" | "aws";

export type InvokeTrace = Record<string, string | number | boolean | undefined>;
export type InvokeErrorCode =
  | "INVALID_PAYLOAD"
  | "INVALID_RESULT"
  | "LOCAL_FUNCTION_FAILED"
  | "MISSING_FUNCTION"
  | "MISSING_TRANSPORT"
  | "TIMEOUT"
  | "TRANSPORT_FAILED"
  | "TRANSPORT_STATUS_ERROR";

export interface InvokeErrorOptions {
  cause?: unknown;
  code: InvokeErrorCode;
  functionName?: string;
  issues?: readonly StandardSchemaIssue[];
  requestId?: string;
  statusCode?: number;
}

export class InvokeError extends Error {
  code: InvokeErrorCode;
  functionName?: string;
  issues?: readonly StandardSchemaIssue[];
  requestId?: string;
  statusCode?: number;

  constructor(message: string, options: InvokeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "InvokeError";
    this.code = options.code;
    this.functionName = options.functionName;
    this.issues = options.issues;
    this.requestId = options.requestId;
    this.statusCode = options.statusCode;
  }
}

export interface InvokeContext {
  functionName: string;
  trace: InvokeTrace;
}

export interface AsyncInvokeResult {
  accepted: true;
  requestId?: string;
}

export interface SqsEventSourceOptions {
  batchSize?: number;
  enabled?: boolean;
  maxBatchingWindowSeconds?: number;
}

export interface SqsEventSourceDefinition {
  readonly options: SqsEventSourceOptions;
  readonly queue: string;
  readonly source: "sqs";
}

export type EventSourceDefinition = SqsEventSourceDefinition;

export interface FunctionSynthesisConfig {
  entrypoint?: string;
  environment?: Record<string, string>;
  handler?: string;
  runtime?: VokeNodeRuntime;
}

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

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

type StandardSchemaInput<TSchema> = TSchema extends {
  readonly "~standard": { readonly types: { input: infer TInput } };
}
  ? TInput
  : TSchema extends {
        readonly "~standard": {
          validate(value: infer TInput): unknown;
        };
      }
    ? TInput
    : never;

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

export interface SqsMessageAttribute {
  binaryListValues?: string[];
  binaryValue?: string;
  dataType: string;
  stringListValues?: string[];
  stringValue?: string;
}

export interface SqsRecord {
  attributes: Record<string, string>;
  awsRegion: string;
  body: string;
  eventSource: "aws:sqs";
  eventSourceARN: string;
  md5OfBody: string;
  messageAttributes: Record<string, SqsMessageAttribute>;
  messageId: string;
  receiptHandle: string;
}

export interface SqsAwsEvent {
  Records: SqsRecord[];
}

export interface SqsBatchItemFailure {
  itemIdentifier: string;
}

export interface SqsBatchResult {
  batchItemFailures: SqsBatchItemFailure[];
}

export interface SqsValidMessage<TBody> {
  attributes: Record<string, string>;
  body: TBody;
  id: string;
  messageAttributes: Record<string, SqsMessageAttribute>;
  raw: SqsRecord;
  valid: true;
}

export interface SqsInvalidMessage {
  attributes: Record<string, string>;
  error: InvokeError;
  id: string;
  messageAttributes: Record<string, SqsMessageAttribute>;
  raw: SqsRecord;
  rawBody: string;
  valid: false;
}

export interface SqsBatchResultBuilder extends SqsBatchResult {
  fail(message: Pick<SqsInvalidMessage | SqsValidMessage<unknown>, "id">): void;
}

export interface SqsMessageBatch<TMessage> {
  batchResult(): SqsBatchResultBuilder;
  messages: SqsValidMessage<TMessage>[];
  ok(): SqsBatchResult;
  source: "sqs";
}

export interface SqsMessageBatchIncludeInvalid<TMessage> {
  batchResult(): SqsBatchResultBuilder;
  messages: (SqsInvalidMessage | SqsValidMessage<TMessage>)[];
  ok(): SqsBatchResult;
  source: "sqs";
}

export type SqsInvalidMessageBodyMode = "fail" | "include";

type SqsEventInvocationBody<TBody, TInvalidMessageBody> =
  TInvalidMessageBody extends "include" ? TBody | unknown : TBody;

export interface SqsMessageBatchOptions<
  TInvalidMessageBody extends SqsInvalidMessageBodyMode =
    SqsInvalidMessageBodyMode,
> {
  invalidMessageBody?: TInvalidMessageBody;
}

export interface SqsEventInvocationMessage<TBody> {
  attributes?: Record<string, string>;
  body: TBody;
  id?: string;
  messageAttributes?: Record<string, SqsMessageAttribute>;
  raw?: SqsRecord;
}

export interface SqsEventInvocationInput<TBody = unknown> {
  messages: SqsEventInvocationMessage<TBody>[];
  source?: "sqs";
}

export type EventInvocationInput<TBody = unknown> =
  SqsEventInvocationInput<TBody>;

export interface SqsMessageBatchSchema<
  TBodySchema extends AnyStandardSchema = AnyStandardSchema,
  TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
> extends StandardSchemaV1<
  SqsEventInvocationInput<StandardSchemaInput<TBodySchema>>,
  TInvalidMessageBody extends "include"
    ? SqsMessageBatchIncludeInvalid<StandardSchemaOutput<TBodySchema>>
    : SqsMessageBatch<StandardSchemaOutput<TBodySchema>>
> {
  readonly body: TBodySchema;
  readonly invalidMessageBody: TInvalidMessageBody;
  readonly source: "sqs";
}

type FunctionKind = "authorizer" | "event" | "invokable" | "route";
export type RouteAuthorizerReference = "none" | string;

export interface RouteAuthContext {
  readonly context: Record<string, unknown>;
  readonly source: "lambda";
}

export type RouteMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

export type RouteReturn<TResult> =
  | TResult
  | Promise<TResult>
  | Response
  | Promise<Response>;

export interface RouteRequest<
  TBody = undefined,
  TParams = Record<string, string>,
  TQuery = URLSearchParams,
  THeaders = Headers,
> {
  readonly auth: RouteAuthContext;
  readonly body: TBody;
  readonly headers: THeaders;
  readonly params: TParams;
  readonly query: TQuery;
  readonly raw: Request;
  readonly request: Request;
}

export type RouteHandler<TBody, TParams, TQuery, THeaders, TResult> = (
  request: RouteRequest<TBody, TParams, TQuery, THeaders>
) => RouteReturn<TResult>;

type RouteSchemaOutput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? unknown extends StandardSchemaOutput<TSchema>
    ? TFallback
    : StandardSchemaOutput<TSchema>
  : TFallback;

type RouteSchemaInput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? unknown extends StandardSchemaInput<TSchema>
    ? TFallback
    : StandardSchemaInput<TSchema>
  : TFallback;

export interface RouteDefinitionInput<
  _TMethod extends RouteMethod,
  _TPath extends string,
  TBodySchema extends AnyStandardSchema | undefined,
  TParamsSchema extends AnyStandardSchema | undefined,
  TQuerySchema extends AnyStandardSchema | undefined,
  THeadersSchema extends AnyStandardSchema | undefined,
  TOutputSchema extends AnyStandardSchema | undefined,
  TResult,
> {
  readonly authorizer?: RouteAuthorizerReference;
  readonly body?: TBodySchema;
  readonly handler: RouteHandler<
    RouteSchemaOutput<TBodySchema, undefined>,
    RouteSchemaOutput<TParamsSchema, Record<string, string>>,
    RouteSchemaOutput<TQuerySchema, Record<string, string>>,
    RouteSchemaOutput<THeadersSchema, Headers>,
    TResult
  >;
  readonly headers?: THeadersSchema;
  readonly middleware?: readonly MiddlewareHandler<VokeEnv>[];
  readonly output?: TOutputSchema;
  readonly params?: TParamsSchema;
  readonly query?: TQuerySchema;
}

export interface RouteDefinition<
  TMethod extends RouteMethod = RouteMethod,
  TPath extends string = string,
  TBodySchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  TParamsSchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  TQuerySchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  THeadersSchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  TOutputSchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  TResult = unknown,
> extends RouteDefinitionInput<
  TMethod,
  TPath,
  TBodySchema,
  TParamsSchema,
  TQuerySchema,
  THeadersSchema,
  TOutputSchema,
  TResult
> {
  readonly method: TMethod;
  readonly middleware: readonly MiddlewareHandler<VokeEnv>[];
  readonly path: TPath;
}

type AnyRouteDefinition = Omit<
  RouteDefinition<
    RouteMethod,
    string,
    AnyStandardSchema | undefined,
    AnyStandardSchema | undefined,
    AnyStandardSchema | undefined,
    AnyStandardSchema | undefined,
    AnyStandardSchema | undefined,
    unknown
  >,
  "handler"
> & {
  readonly handler: RouteHandler<never, never, never, never, unknown>;
};

export interface RouteInvocationInput<TRoute> {
  readonly auth?: RouteAuthContext;
  readonly body?: TRoute extends { readonly body?: infer TSchema }
    ? RouteSchemaInput<TSchema, undefined>
    : undefined;
  readonly headers?: TRoute extends { readonly headers?: infer TSchema }
    ? RouteSchemaInput<TSchema, Headers | Record<string, string>>
    : Headers | Record<string, string>;
  readonly params?: TRoute extends { readonly params?: infer TSchema }
    ? RouteSchemaInput<TSchema, Record<string, string>>
    : Record<string, string>;
  readonly query?: TRoute extends { readonly query?: infer TSchema }
    ? RouteSchemaInput<TSchema, URLSearchParams | Record<string, string>>
    : Record<string, string> | URLSearchParams;
  readonly request?: Request;
}

export type RouteInvocationOutput<TRoute> = TRoute extends {
  readonly output?: infer TSchema;
}
  ? TSchema extends AnyStandardSchema
    ? StandardSchemaOutput<TSchema>
    : TRoute extends RouteDefinition<
          RouteMethod,
          string,
          AnyStandardSchema | undefined,
          AnyStandardSchema | undefined,
          AnyStandardSchema | undefined,
          AnyStandardSchema | undefined,
          AnyStandardSchema | undefined,
          infer TResult
        >
      ? TResult extends Response
        ? Response
        : TResult
      : never
  : never;

type RoutesForMethodAndPath<TRegistry, TMethod, TPath> = {
  [TKey in keyof TRegistry]: TRegistry[TKey] extends {
    readonly routes: readonly (infer TRoute)[];
  }
    ? TRoute extends {
        readonly method: TMethod;
        readonly path: TPath;
      }
      ? TRoute
      : never
    : never;
}[keyof TRegistry];

type RegistryRoute<TRegistry> = {
  [TKey in keyof TRegistry]: TRegistry[TKey] extends {
    readonly routes: readonly (infer TRoute)[];
  }
    ? TRoute
    : never;
}[keyof TRegistry];

type RegistryRouteMethod<TRegistry> =
  RegistryRoute<TRegistry> extends infer TRoute
    ? TRoute extends { readonly method: infer TMethod }
      ? TMethod
      : never
    : never;

type RegistryRoutePath<TRegistry, TMethod> =
  RegistryRoute<TRegistry> extends infer TRoute
    ? TRoute extends {
        readonly method: TMethod;
        readonly path: infer TPath;
      }
      ? TPath
      : never
    : never;

export type FunctionRegistryRoute<TRegistry> = <
  TMethod extends RegistryRouteMethod<TRegistry> & RouteMethod,
  TPath extends RegistryRoutePath<TRegistry, TMethod> & string,
>(
  method: TMethod,
  path: TPath,
  request?: RouteInvocationInput<
    RoutesForMethodAndPath<TRegistry, TMethod, TPath>
  >
) => Promise<
  RouteInvocationOutput<RoutesForMethodAndPath<TRegistry, TMethod, TPath>>
>;

export type FunctionHandler<TPayload, TResult> = (
  payload: TPayload,
  context: InvokeContext
) => TResult | Promise<TResult>;

export type EventFunctionHandler<TPayload> = (
  payload: TPayload,
  context: InvokeContext
) => SqsBatchResult | Promise<SqsBatchResult>;

export interface BaseFunctionDefinition<
  TKey extends string = string,
  TKind extends FunctionKind = FunctionKind,
> {
  readonly key: TKey;
  readonly kind: TKind;
  readonly name?: string;
  readonly synthesis?: FunctionSynthesisConfig;
}

export type InvokableFunctionDefinition<
  TKey extends string = string,
  TInputSchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  TOutputSchema extends AnyStandardSchema = AnyStandardSchema,
> = BaseFunctionDefinition<TKey, "invokable"> & {
  readonly handler: FunctionHandler<
    TInputSchema extends AnyStandardSchema
      ? StandardSchemaOutput<TInputSchema>
      : undefined,
    | StandardSchemaInput<TOutputSchema>
    | Promise<StandardSchemaInput<TOutputSchema>>
  >;
  readonly output: TOutputSchema;
} & (TInputSchema extends AnyStandardSchema
    ? { readonly input: TInputSchema }
    : { readonly input?: undefined });

export type RouteFunctionDefinition<
  TKey extends string = string,
  TRoutes extends readonly AnyRouteDefinition[] = readonly AnyRouteDefinition[],
> = BaseFunctionDefinition<TKey, "route"> & {
  readonly authorizer?: string;
  readonly authorizers?: AuthorizerRegistryInput;
  readonly routes: TRoutes;
};

export type EventFunctionDefinition<
  TKey extends string = string,
  TInputSchema extends SqsMessageBatchSchema<
    AnyStandardSchema,
    SqsInvalidMessageBodyMode
  > = SqsMessageBatchSchema<AnyStandardSchema, SqsInvalidMessageBodyMode>,
> = BaseFunctionDefinition<TKey, "event"> & {
  readonly events: readonly EventSourceDefinition[];
  readonly handler: EventFunctionHandler<StandardSchemaOutput<TInputSchema>>;
  readonly input: TInputSchema;
};

export type FunctionDefinition<
  TKey extends string = string,
  TInputSchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  TOutputSchema extends AnyStandardSchema = AnyStandardSchema,
> =
  | RequestAuthorizerFunctionDefinition<TKey>
  | EventFunctionDefinition<TKey>
  | InvokableFunctionDefinition<TKey, TInputSchema, TOutputSchema>
  | RouteFunctionDefinition<TKey>;

export type AnyFunctionDefinition = BaseFunctionDefinition<string> & {
  readonly authorizer?: string;
  readonly authorizers?: AuthorizerRegistryInput;
  readonly context?: AnyStandardSchema;
  readonly events?: readonly EventSourceDefinition[];
  readonly handler?:
    | FunctionHandler<never, unknown>
    | ((payload: never) => unknown);
  readonly input?: AnyStandardSchema;
  readonly output?: AnyStandardSchema;
  readonly routes?: readonly AnyRouteDefinition[];
};

interface FunctionDefinitionInputBase {
  name?: string;
  routes?: readonly AnyRouteDefinition[];
  synthesis?: FunctionSynthesisConfig;
}

type InvokableFunctionWithInputDefinitionInput<
  TInputSchema extends AnyStandardSchema,
  TOutputSchema extends AnyStandardSchema,
> = FunctionDefinitionInputBase & {
  handler: FunctionHandler<
    StandardSchemaOutput<TInputSchema>,
    | StandardSchemaInput<TOutputSchema>
    | Promise<StandardSchemaInput<TOutputSchema>>
  >;
  input: TInputSchema;
  output: TOutputSchema;
};

type InvokableZeroInputFunctionDefinitionInput<
  TOutputSchema extends AnyStandardSchema,
> = FunctionDefinitionInputBase & {
  handler: FunctionHandler<
    undefined,
    | StandardSchemaInput<TOutputSchema>
    | Promise<StandardSchemaInput<TOutputSchema>>
  >;
  output: TOutputSchema;
};

type RouteFunctionDefinitionInput<
  TRoutes extends readonly AnyRouteDefinition[] = readonly AnyRouteDefinition[],
> = Omit<FunctionDefinitionInputBase, "routes"> & {
  readonly routes?: TRoutes;
};

type RouteInputList<
  TRoutes extends AnyRouteDefinition | readonly AnyRouteDefinition[],
> = TRoutes extends readonly AnyRouteDefinition[]
  ? TRoutes
  : readonly [TRoutes];

export interface HttpFunctionDefinitionInput<
  TRoutes extends AnyRouteDefinition | readonly AnyRouteDefinition[],
> extends Omit<FunctionDefinitionInputBase, "routes"> {
  readonly authorizer?: string;
  readonly authorizers?: AuthorizerRegistryInput;
  readonly routes: TRoutes;
}

type EventFunctionDefinitionInput<
  TInputSchema extends SqsMessageBatchSchema<
    AnyStandardSchema,
    SqsInvalidMessageBodyMode
  >,
> = Omit<FunctionDefinitionInputBase, "routes"> & {
  readonly events: readonly EventSourceDefinition[];
  readonly handler: EventFunctionHandler<StandardSchemaOutput<TInputSchema>>;
  readonly input: TInputSchema;
};

type SqsQueueInput =
  | string
  | ({ readonly queue: string } & SqsEventSourceOptions);

type SqsQueueListInput = SqsQueueInput | readonly SqsQueueInput[];

export interface SqsFunctionDefinitionInput<
  TMessageSchema extends AnyStandardSchema,
  TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
>
  extends Omit<FunctionDefinitionInputBase, "routes">, SqsEventSourceOptions {
  readonly handler: EventFunctionHandler<
    StandardSchemaOutput<
      SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>
    >
  >;
  readonly invalidMessageBody?: TInvalidMessageBody;
  readonly message: TMessageSchema;
  readonly queue?: string;
  readonly queues?: SqsQueueListInput;
}

export type FunctionRegistryInput = Record<string, AnyFunctionDefinition>;

type FunctionDefinitionWithKey<
  TDefinition,
  TKey extends string,
> = TDefinition extends {
  readonly kind: "authorizer";
}
  ? RequestAuthorizerFunctionDefinition<TKey>
  : TDefinition extends {
        readonly events: readonly EventSourceDefinition[];
        readonly input: infer TInputSchema;
        readonly kind: "event";
      }
    ? TInputSchema extends SqsMessageBatchSchema<
        AnyStandardSchema,
        SqsInvalidMessageBodyMode
      >
      ? EventFunctionDefinition<TKey, TInputSchema>
      : never
    : TDefinition extends {
          readonly input: infer TInputSchema;
          readonly kind: "invokable";
          readonly output: infer TOutputSchema;
        }
      ? TInputSchema extends AnyStandardSchema
        ? TOutputSchema extends AnyStandardSchema
          ? InvokableFunctionDefinition<TKey, TInputSchema, TOutputSchema>
          : never
        : never
      : TDefinition extends {
            readonly kind: "invokable";
            readonly output: infer TOutputSchema;
          }
        ? TOutputSchema extends AnyStandardSchema
          ? InvokableFunctionDefinition<TKey, undefined, TOutputSchema>
          : never
        : TDefinition extends RouteFunctionDefinition<string, infer TRoutes>
          ? RouteFunctionDefinition<TKey, TRoutes>
          : never;

export type FunctionRegistry<
  TRegistry extends FunctionRegistryInput = Record<never, never>,
> = {
  readonly [TKey in keyof TRegistry as TKey extends "invoke"
    ? never
    : TKey]: FunctionDefinitionWithKey<TRegistry[TKey], TKey & string>;
} & {
  readonly invoke: FunctionRegistryInvoke<{
    readonly [TKey in keyof TRegistry as TKey extends "invoke"
      ? never
      : TKey]: FunctionDefinitionWithKey<TRegistry[TKey], TKey & string>;
  }>;
  readonly route: FunctionRegistryRoute<{
    readonly [TKey in keyof TRegistry as TKey extends "invoke" | "route"
      ? never
      : TKey]: FunctionDefinitionWithKey<TRegistry[TKey], TKey & string>;
  }>;
  readonly sendEvent: FunctionRegistrySendEvent<{
    readonly [TKey in keyof TRegistry as TKey extends
      | "invoke"
      | "route"
      | "sendEvent"
      ? never
      : TKey]: FunctionDefinitionWithKey<TRegistry[TKey], TKey & string>;
  }>;
};

export interface InvokeRequest<TPayload = unknown> {
  functionName: string;
  invocationType: "RequestResponse" | "Event";
  payload: {
    payload: TPayload;
    trace: InvokeTrace;
  };
}

export interface InvokeTransportResponse<TResult = unknown> {
  functionError?: string;
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
  onAsyncError?: (error: InvokeError) => void;
}

type FunctionInput<TFunction> = TFunction extends {
  readonly input: infer TInputSchema;
}
  ? TInputSchema extends AnyStandardSchema
    ? StandardSchemaInput<TInputSchema>
    : undefined
  : never;

type FunctionOutput<TFunction> = TFunction extends {
  readonly output: infer TOutputSchema;
}
  ? TOutputSchema extends AnyStandardSchema
    ? StandardSchemaOutput<TOutputSchema>
    : never
  : never;

type ZeroInputFunctionKey<TRegistry> = {
  [TKey in keyof TRegistry]: TRegistry[TKey] extends {
    readonly handler: unknown;
    readonly input?: undefined;
    readonly output: AnyStandardSchema;
  }
    ? TKey
    : never;
}[keyof TRegistry];

type PayloadInputFunctionKey<TRegistry> = {
  [TKey in keyof TRegistry]: TRegistry[TKey] extends {
    readonly handler: unknown;
    readonly input: AnyStandardSchema;
    readonly output: AnyStandardSchema;
  }
    ? TKey
    : never;
}[keyof TRegistry];

type InvokeResult<TResult, TOptions> = TOptions extends { mode: "async" }
  ? AsyncInvokeResult
  : TOptions extends { mode?: InvokeMode }
    ? TResult | AsyncInvokeResult
    : TResult;

type EventFunctionKey<TRegistry> = {
  [TKey in keyof TRegistry]: TRegistry[TKey] extends {
    readonly events: readonly EventSourceDefinition[];
    readonly handler: unknown;
    readonly input: SqsMessageBatchSchema<
      AnyStandardSchema,
      SqsInvalidMessageBodyMode
    >;
  }
    ? TKey
    : never;
}[keyof TRegistry];

type EventFunctionInput<TFunction> = TFunction extends {
  readonly input: infer TInputSchema;
}
  ? TInputSchema extends SqsMessageBatchSchema<
      infer TBodySchema,
      infer TInvalidMessageBody
    >
    ? SqsEventInvocationInput<
        SqsEventInvocationBody<
          StandardSchemaInput<TBodySchema>,
          TInvalidMessageBody
        >
      >
    : never
  : never;

export type FunctionRegistrySendEvent<TRegistry> = <
  TKey extends EventFunctionKey<TRegistry>,
>(
  functionName: TKey,
  event: EventFunctionInput<TRegistry[TKey]>
) => Promise<SqsBatchResult>;

export interface SqsEventHandlerOptions<
  TRegistry extends FunctionRegistryInput = FunctionRegistryInput,
> {
  function: Parameters<FunctionRegistry<TRegistry>["sendEvent"]>[0];
  functions: FunctionRegistry<TRegistry>;
}

export interface FunctionRegistryInvoke<TRegistry> {
  <
    TKey extends PayloadInputFunctionKey<TRegistry>,
    TOptions extends InvokeOptions | undefined = undefined,
  >(
    functionName: TKey,
    payload: FunctionInput<TRegistry[TKey]>,
    options?: TOptions
  ): Promise<InvokeResult<FunctionOutput<TRegistry[TKey]>, TOptions>>;
  <
    TKey extends ZeroInputFunctionKey<TRegistry>,
    TOptions extends InvokeOptions | undefined = undefined,
  >(
    functionName: TKey,
    payload?: undefined,
    options?: TOptions
  ): Promise<InvokeResult<FunctionOutput<TRegistry[TKey]>, TOptions>>;
}

const traceStack: InvokeTrace[] = [];
const activatedFunctionRegistries = new WeakMap<object, string>();
const reservedFunctionRegistryKeys = new Set(["invoke", "route", "sendEvent"]);

const currentTrace = (): InvokeTrace => traceStack.at(-1) ?? {};

export const activateFunctionRegistry = (
  registry: object,
  activationKey: string
): void => {
  const previousActivationKey = activatedFunctionRegistries.get(registry);

  if (
    previousActivationKey !== undefined &&
    previousActivationKey !== activationKey
  ) {
    throw new VokeConfigError(
      "Function Registry is already activated with a different Gateway context"
    );
  }

  activatedFunctionRegistries.set(registry, activationKey);
};

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

const deployedName = (definition: BaseFunctionDefinition): string =>
  definition.name ?? definition.key;

const formatIssue = (issue: StandardSchemaIssue): string => {
  if (issue.path === undefined || issue.path.length === 0) {
    return issue.message;
  }

  return `${issue.path.map(String).join(".")}: ${issue.message}`;
};

const parseWithSchema = async <TInput, TOutput>(
  schema: StandardSchemaV1<TInput, TOutput>,
  value: TInput,
  errorFactory: (
    message: string,
    cause?: unknown,
    issues?: readonly StandardSchemaIssue[]
  ) => InvokeError
): Promise<TOutput> => {
  try {
    const result = await schema["~standard"].validate(value);

    if (result.success) {
      return result.data;
    }

    throw errorFactory(
      result.issues.map(formatIssue).join("; "),
      undefined,
      result.issues
    );
  } catch (error) {
    if (error instanceof InvokeError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw errorFactory(message, error);
  }
};

const createSqsBatchResult = (
  failures: SqsBatchItemFailure[] = []
): SqsBatchResultBuilder => {
  const result: SqsBatchResultBuilder = {
    batchItemFailures: failures,
    fail(message) {
      if (
        !this.batchItemFailures.some(
          (failure) => failure.itemIdentifier === message.id
        )
      ) {
        this.batchItemFailures.push({ itemIdentifier: message.id });
      }
    },
  };
  Object.defineProperty(result, "fail", {
    enumerable: false,
    value: result.fail,
  });

  return result;
};

const createSqsRecord = (
  message: SqsEventInvocationMessage<unknown>,
  index: number
): SqsRecord => {
  if (message.raw !== undefined) {
    return message.raw;
  }

  const body =
    typeof message.body === "string"
      ? message.body
      : JSON.stringify(message.body);
  const id = message.id ?? `msg_${index + 1}`;

  return {
    attributes: message.attributes ?? {},
    awsRegion: "local",
    body,
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:local:000000000000:local",
    md5OfBody: "",
    messageAttributes: message.messageAttributes ?? {},
    messageId: id,
    receiptHandle: `receipt-${id}`,
  };
};

const sqsInvocationFromAwsEvent = (
  event: SqsAwsEvent
): SqsEventInvocationInput<unknown> => ({
  messages: event.Records.map((record) => ({
    attributes: record.attributes,
    body: record.body,
    id: record.messageId,
    messageAttributes: record.messageAttributes,
    raw: record,
  })),
  source: "sqs",
});

const parseSqsMessageBatch = async <
  TBodySchema extends AnyStandardSchema,
  TInvalidMessageBody extends SqsInvalidMessageBodyMode,
>(
  schema: SqsMessageBatchSchema<TBodySchema, TInvalidMessageBody>,
  input: SqsEventInvocationInput<StandardSchemaInput<TBodySchema>>
): Promise<StandardSchemaOutput<typeof schema>> => {
  const failures: SqsBatchItemFailure[] = [];
  const messages: (
    | SqsInvalidMessage
    | SqsValidMessage<StandardSchemaOutput<TBodySchema>>
  )[] = [];

  for (const [index, message] of input.messages.entries()) {
    const raw = createSqsRecord(message, index);
    let body: StandardSchemaOutput<TBodySchema>;

    try {
      const parsedJson = JSON.parse(
        raw.body
      ) as StandardSchemaInput<TBodySchema>;
      body = (await parseWithSchema(
        schema.body,
        parsedJson,
        (text, cause) =>
          new InvokeError(
            `Invalid SQS message body for ${raw.messageId}: ${text}`,
            {
              cause,
              code: "INVALID_PAYLOAD",
              functionName: raw.messageId,
            }
          )
      )) as StandardSchemaOutput<TBodySchema>;
    } catch (error) {
      const invokeError =
        error instanceof InvokeError
          ? error
          : new InvokeError(
              `Invalid SQS message body for ${raw.messageId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              {
                cause: error,
                code: "INVALID_PAYLOAD",
                functionName: raw.messageId,
              }
            );

      failures.push({ itemIdentifier: raw.messageId });

      if (schema.invalidMessageBody === "include") {
        messages.push({
          attributes: raw.attributes,
          error: invokeError,
          id: raw.messageId,
          messageAttributes: raw.messageAttributes,
          raw,
          rawBody: raw.body,
          valid: false,
        });
      }

      continue;
    }

    messages.push({
      attributes: raw.attributes,
      body,
      id: raw.messageId,
      messageAttributes: raw.messageAttributes,
      raw,
      valid: true,
    });
  }

  const batch = {
    batchResult: () => createSqsBatchResult([...failures]),
    messages,
    ok: () => ({ batchItemFailures: [...failures] }),
    source: "sqs",
  };

  return batch as StandardSchemaOutput<typeof schema>;
};

export const sqsEventSource = (
  queue: string,
  options: SqsEventSourceOptions = {}
): SqsEventSourceDefinition => ({
  options,
  queue,
  source: "sqs",
});

export const sqsMessageBatch = <
  const TBodySchema extends AnyStandardSchema,
  const TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
>(
  body: TBodySchema,
  options: SqsMessageBatchOptions<TInvalidMessageBody> = {}
): SqsMessageBatchSchema<TBodySchema, TInvalidMessageBody> => ({
  body,
  invalidMessageBody:
    options.invalidMessageBody ?? ("fail" as TInvalidMessageBody),
  source: "sqs",
  "~standard": {
    validate: async (value) => ({
      data: await parseSqsMessageBatch(
        {
          body,
          invalidMessageBody: options.invalidMessageBody ?? "fail",
          source: "sqs",
        } as SqsMessageBatchSchema<TBodySchema, TInvalidMessageBody>,
        value
      ),
      success: true,
    }),
    vendor: "voke",
    version: 1,
  },
});

const parsePayload = async <TInputSchema extends AnyStandardSchema | undefined>(
  definition: InvokableFunctionDefinition<string, TInputSchema>,
  payload: FunctionInput<typeof definition>
): Promise<
  TInputSchema extends AnyStandardSchema
    ? StandardSchemaOutput<TInputSchema>
    : undefined
> => {
  if (definition.input === undefined) {
    return undefined as TInputSchema extends AnyStandardSchema
      ? StandardSchemaOutput<TInputSchema>
      : undefined;
  }

  const functionName = deployedName(definition);

  return (await parseWithSchema(
    definition.input,
    payload as StandardSchemaInput<TInputSchema>,
    (message, cause, issues) =>
      new InvokeError(`Invalid payload for ${functionName}: ${message}`, {
        cause,
        code: "INVALID_PAYLOAD",
        functionName,
        issues,
      })
  )) as TInputSchema extends AnyStandardSchema
    ? StandardSchemaOutput<TInputSchema>
    : undefined;
};

const parseResult = async <TOutputSchema extends AnyStandardSchema>(
  definition: InvokableFunctionDefinition<
    string,
    AnyStandardSchema | undefined,
    TOutputSchema
  >,
  result: StandardSchemaInput<TOutputSchema>
): Promise<StandardSchemaOutput<TOutputSchema>> => {
  const functionName = deployedName(definition);

  return (await parseWithSchema(
    definition.output,
    result,
    (message, cause, issues) =>
      new InvokeError(`Invalid result from ${functionName}: ${message}`, {
        cause,
        code: "INVALID_RESULT",
        functionName,
        issues,
      })
  )) as StandardSchemaOutput<TOutputSchema>;
};

const parseRoutePart = async <TSchema extends AnyStandardSchema | undefined>(
  schema: TSchema,
  value: RouteSchemaInput<TSchema, unknown>,
  part: string,
  route: AnyRouteDefinition,
  code: Extract<
    InvokeErrorCode,
    "INVALID_PAYLOAD" | "INVALID_RESULT"
  > = "INVALID_PAYLOAD"
): Promise<RouteSchemaOutput<TSchema, typeof value>> => {
  if (schema === undefined) {
    return value as RouteSchemaOutput<TSchema, typeof value>;
  }

  return (await parseWithSchema(schema, value, (message, cause, issues) => {
    const prefixedIssues = issues?.map((issue) => ({
      ...issue,
      path: [part, ...(issue.path ?? [])],
    }));

    return new InvokeError(
      `Invalid ${part} for ${route.method} ${route.path}: ${message}`,
      {
        cause,
        code,
        functionName: `${route.method} ${route.path}`,
        issues: prefixedIssues,
      }
    );
  })) as RouteSchemaOutput<TSchema, typeof value>;
};

const headersFromInput = (
  headers: Headers | Record<string, string> | undefined
): Headers => {
  if (headers instanceof Headers) {
    return headers;
  }

  return new Headers(headers);
};

const searchParamsFromUrl = (url: string): URLSearchParams =>
  new URL(url).searchParams;

const bodyFromRequest = async (request: Request): Promise<unknown> => {
  if (request.body === null) {
    return undefined;
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return await request.clone().json();
  }

  return await request.clone().text();
};

const createRouteRequest = async (
  route: AnyRouteDefinition,
  input: RouteInvocationInput<AnyRouteDefinition>
): Promise<RouteRequest<unknown, unknown, unknown, unknown>> => {
  const headers = headersFromInput(
    input.headers as Headers | Record<string, string> | undefined
  );
  const request =
    input.request ??
    new Request("http://localhost/", {
      body:
        input.body === undefined ||
        route.method === "GET" ||
        route.method === "HEAD"
          ? undefined
          : JSON.stringify(input.body),
      headers,
      method: route.method,
    });
  const rawBody =
    input.body ??
    (route.body === undefined ? undefined : await bodyFromRequest(request));
  const parsedBody = await parseRoutePart(route.body, rawBody, "body", route);
  const parsedHeaders = await parseRoutePart(
    route.headers,
    headers,
    "headers",
    route
  );
  const parsedParams = await parseRoutePart(
    route.params,
    input.params ?? {},
    "params",
    route
  );
  const parsedQuery = await parseRoutePart(
    route.query,
    input.query ?? searchParamsFromUrl(request.url),
    "query",
    route
  );

  return {
    auth: input.auth ?? { context: {}, source: "lambda" },
    body: parsedBody,
    headers: parsedHeaders,
    params: parsedParams,
    query: parsedQuery,
    raw: request,
    request,
  };
};

const parseRouteOutput = async (
  route: AnyRouteDefinition,
  value: unknown
): Promise<unknown> => {
  if (value instanceof Response || route.output === undefined) {
    return value;
  }

  return await parseRoutePart(
    route.output,
    value,
    "result",
    route,
    "INVALID_RESULT"
  );
};

const runRoute = async (
  route: AnyRouteDefinition,
  input: RouteInvocationInput<AnyRouteDefinition>
): Promise<unknown> => {
  const request = await createRouteRequest(route, input);
  const result = await route.handler(
    request as RouteRequest<never, never, never, never>
  );

  return await parseRouteOutput(route, result);
};

const routeResponse = async (
  route: AnyRouteDefinition,
  input: RouteInvocationInput<AnyRouteDefinition>
): Promise<Response> => {
  const result = await runRoute(route, input);

  if (result instanceof Response) {
    return result;
  }

  if (result === undefined) {
    return new Response(null, { status: 204 });
  }

  return json(result);
};

const contextHeaders = (context: Context<VokeEnv>): Headers =>
  new Headers(context.req.raw.headers);

const identityHeaderName = (identitySource: string): string | undefined => {
  const match = /^\$request\.header\.([^.\s]+)$/iu.exec(identitySource);

  return match?.[1];
};

const routeAuthorizerName = (
  route: AnyRouteDefinition,
  definition: AnyFunctionDefinition
): string | undefined => {
  const authorizer = route.authorizer ?? definition.authorizer;

  return authorizer === "none" ? undefined : authorizer;
};

const evaluateLocalAuthorizer = async (
  route: AnyRouteDefinition,
  definition: AnyFunctionDefinition,
  registry: FunctionRegistry | FunctionRegistryInput,
  request: Request,
  headers: Headers
): Promise<Response | RouteAuthContext | undefined> => {
  const authorizerName = routeAuthorizerName(route, definition);

  if (authorizerName === undefined) {
    return undefined;
  }

  const authorizer = definition.authorizers?.[authorizerName];

  if (authorizer?.kind !== "lambda") {
    return undefined;
  }

  const hasIdentity = authorizer.identitySource.some((source) => {
    const header = identityHeaderName(source);

    return header !== undefined && headers.get(header) !== null;
  });

  if (!hasIdentity) {
    return jsonError("Unauthorized", { code: "UNAUTHORIZED", status: 401 });
  }

  if (typeof authorizer.function !== "string") {
    return jsonError("External authorizers are not available locally", {
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
    });
  }

  const target = (registry as FunctionRegistryInput)[authorizer.function];

  if (target?.kind !== "authorizer" || target.handler === undefined) {
    return jsonError("Authorizer not found", {
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
    });
  }

  try {
    const handler = target.handler as RequestAuthorizerHandler;
    const result = await handler({
      headers,
      raw: request,
      request,
    });

    if (typeof result.authorized !== "boolean") {
      return jsonError("Invalid authorizer result", {
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
      });
    }

    if (result.authorized !== true) {
      return jsonError("Forbidden", { code: "FORBIDDEN", status: 403 });
    }

    const context =
      target.context === undefined
        ? (result.context ?? {})
        : await parseWithSchema(
            target.context as StandardSchemaV1<
              unknown,
              Record<string, unknown>
            >,
            result.context,
            (message, cause, issues) =>
              new InvokeError(`Invalid authorizer context: ${message}`, {
                cause,
                code: "INVALID_RESULT",
                issues,
              })
          );

    return {
      context,
      source: "lambda",
    };
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Authorizer failed",
      { code: "INTERNAL_SERVER_ERROR", status: 500 }
    );
  }
};

const mountRoute = (
  app: Hono<VokeEnv>,
  route: AnyRouteDefinition,
  definition: AnyFunctionDefinition,
  registry: FunctionRegistry | FunctionRegistryInput
): void => {
  app.on([route.method], [route.path], ...route.middleware, async (context) => {
    const headers = contextHeaders(context);
    const auth = await evaluateLocalAuthorizer(
      route,
      definition,
      registry,
      context.req.raw,
      headers
    );

    if (auth instanceof Response) {
      return auth;
    }

    return await routeResponse(route, {
      auth,
      headers: contextHeaders(context),
      params: context.req.param(),
      query: searchParamsFromUrl(context.req.url),
      request: context.req.raw,
    });
  });
};

const sleepAndThrow = async (
  timeoutMs: number,
  message: string,
  functionName: string
) => {
  await Bun.sleep(timeoutMs);
  throw new InvokeError(message, {
    code: "TIMEOUT",
    functionName,
  });
};

const withTimeout = async <TResult>(
  value: TResult | Promise<TResult>,
  timeoutMs: number | undefined,
  message: string,
  functionName: string
): Promise<TResult> => {
  if (timeoutMs === undefined) {
    return await value;
  }

  return Promise.race([value, sleepAndThrow(timeoutMs, message, functionName)]);
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

const asInvokeError = (
  error: unknown,
  code: InvokeErrorCode,
  functionName: string,
  prefix: string
): InvokeError => {
  if (error instanceof InvokeError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  return new InvokeError(`${prefix}: ${message}`, {
    cause: error,
    code,
    functionName,
  });
};

const runLocalFunction = async <
  TInputSchema extends AnyStandardSchema | undefined,
  TOutputSchema extends AnyStandardSchema,
>(
  definition: InvokableFunctionDefinition<string, TInputSchema, TOutputSchema>,
  payload: FunctionInput<typeof definition>,
  options: InvokeOptions
): Promise<StandardSchemaOutput<TOutputSchema>> => {
  const functionName = deployedName(definition);
  const parsedPayload = await parsePayload(definition, payload);
  const result = await withTimeout(
    definition.handler(parsedPayload, {
      functionName,
      trace: resolveTrace(options),
    }),
    options.timeoutMs,
    `invoke("${functionName}") timed out after ${options.timeoutMs}ms`,
    functionName
  );

  return await parseResult(
    definition as InvokableFunctionDefinition<
      string,
      AnyStandardSchema | undefined,
      TOutputSchema
    >,
    result
  );
};

const runQueuedLocalFunction = async (
  definition: InvokableFunctionDefinition,
  payload: unknown,
  options: InvokeOptions
): Promise<void> => {
  const functionName = deployedName(definition);

  try {
    await runWithRetries(
      () => runLocalFunction(definition, payload, options),
      options
    );
  } catch (error) {
    const invokeError = asInvokeError(
      error,
      "LOCAL_FUNCTION_FAILED",
      functionName,
      `invoke("${functionName}") failed`
    );

    if (options.onAsyncError !== undefined) {
      options.onAsyncError(invokeError);
      return;
    }

    console.error(invokeError.message);
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

let cachedAwsLambdaInvokeTransport: InvokeTransport | undefined;

const defaultAwsLambdaInvokeTransport = (): InvokeTransport => {
  cachedAwsLambdaInvokeTransport ??= createAwsLambdaInvokeTransport();
  return cachedAwsLambdaInvokeTransport;
};

const invokeAws = async (
  definition: InvokableFunctionDefinition,
  payload: unknown,
  options: InvokeOptions
): Promise<unknown> => {
  const transport = options.transport ?? defaultAwsLambdaInvokeTransport();
  const functionName = deployedName(definition);

  const parsedPayload = await parsePayload(definition, payload);
  const response = await runWithRetries(
    () =>
      withTimeout(
        Promise.resolve()
          .then(() =>
            transport.invoke({
              functionName,
              invocationType:
                options.mode === "async" ? "Event" : "RequestResponse",
              payload: {
                payload: parsedPayload,
                trace: resolveTrace(options),
              },
            })
          )
          .catch((error: unknown) => {
            throw asInvokeError(
              error,
              "TRANSPORT_FAILED",
              functionName,
              `invoke("${functionName}") transport failed`
            );
          }),
        options.timeoutMs,
        `invoke("${functionName}") timed out after ${options.timeoutMs}ms`,
        functionName
      ),
    options
  );

  if (options.mode === "async") {
    return {
      accepted: true,
      ...(response.requestId === undefined
        ? {}
        : { requestId: response.requestId }),
    };
  }

  if (
    response.functionError !== undefined ||
    (response.statusCode !== undefined && response.statusCode >= 400)
  ) {
    const statusMessage =
      response.functionError ?? `status ${response.statusCode}`;
    throw new InvokeError(
      `invoke("${functionName}") failed with ${statusMessage}`,
      {
        code: "TRANSPORT_STATUS_ERROR",
        functionName,
        requestId: response.requestId,
        statusCode: response.statusCode,
      }
    );
  }

  return await parseResult(definition, unwrapPayload(response.payload));
};

const invokeFunction = async (
  definition: InvokableFunctionDefinition | undefined,
  payload: unknown,
  options: InvokeOptions = {}
): Promise<unknown> => {
  if (definition === undefined) {
    throw new InvokeError("Cannot invoke an undefined function definition", {
      code: "MISSING_FUNCTION",
    });
  }

  const invokeOptions = {
    ...options,
    trace: resolveTrace(options),
  };

  if (resolveRuntime(invokeOptions) === "aws") {
    return await invokeAws(definition, payload, invokeOptions);
  }

  if (options.mode === "async") {
    void runQueuedLocalFunction(definition, payload, invokeOptions);

    return { accepted: true };
  }

  return await runWithRetries(
    () => runLocalFunction(definition, payload, invokeOptions),
    invokeOptions
  );
};

export const invokeRegistryFunction = async (
  registry: object,
  definition: InvokableFunctionDefinition | undefined,
  payload: unknown,
  options: InvokeOptions = {}
): Promise<unknown> => {
  if (
    resolveRuntime(options) === "local" &&
    !activatedFunctionRegistries.has(registry)
  ) {
    throw new VokeConfigError(
      "Local Function invocation requires Gateway activation. Call voke(functions) before invoking local functions."
    );
  }

  return await invokeFunction(definition, payload, options);
};

const sendEventToFunction = async (
  definition: EventFunctionDefinition | undefined,
  event: EventInvocationInput,
  options: InvokeOptions = {}
): Promise<SqsBatchResult> => {
  if (definition === undefined) {
    throw new InvokeError("Cannot send an event to an undefined function", {
      code: "MISSING_FUNCTION",
    });
  }

  const functionName = deployedName(definition);
  const parsedEvent = await parseWithSchema(
    definition.input,
    event as never,
    (message, cause) =>
      new InvokeError(`Invalid SQS event for ${functionName}: ${message}`, {
        cause,
        code: "INVALID_PAYLOAD",
        functionName,
      })
  );

  return await definition.handler(parsedEvent, {
    functionName,
    trace: resolveTrace(options),
  });
};

export const createSqsEventHandler =
  <const TRegistry extends FunctionRegistryInput>(
    options: SqsEventHandlerOptions<TRegistry>
  ) =>
  async (event: SqsAwsEvent): Promise<SqsBatchResult> =>
    await options.functions.sendEvent(
      options.function,
      sqsInvocationFromAwsEvent(event) as never
    );

export function defineFunction<
  const TInputSchema extends AnyStandardSchema,
  const TOutputSchema extends AnyStandardSchema,
>(
  definition: InvokableFunctionWithInputDefinitionInput<
    TInputSchema,
    TOutputSchema
  >
): InvokableFunctionDefinition<string, TInputSchema, TOutputSchema>;
export function defineFunction<const TOutputSchema extends AnyStandardSchema>(
  definition: InvokableZeroInputFunctionDefinitionInput<TOutputSchema>
): InvokableFunctionDefinition<string, undefined, TOutputSchema>;
export function defineFunction<
  const TInputSchema extends SqsMessageBatchSchema<
    AnyStandardSchema,
    SqsInvalidMessageBodyMode
  >,
>(
  definition: EventFunctionDefinitionInput<TInputSchema>
): EventFunctionDefinition<string, TInputSchema>;
export function defineFunction<
  const TRoutes extends readonly AnyRouteDefinition[],
>(
  definition: RouteFunctionDefinitionInput<TRoutes>
): RouteFunctionDefinition<string, TRoutes>;
export function defineFunction(
  definition:
    | InvokableFunctionWithInputDefinitionInput<
        AnyStandardSchema,
        AnyStandardSchema
      >
    | InvokableZeroInputFunctionDefinitionInput<AnyStandardSchema>
    | (EventFunctionDefinitionInput<
        SqsMessageBatchSchema<AnyStandardSchema, SqsInvalidMessageBodyMode>
      > & {
        readonly output?: AnyStandardSchema;
        readonly routes?: readonly AnyRouteDefinition[];
      })
    | RouteFunctionDefinitionInput
): AnyFunctionDefinition {
  if (definition.name !== undefined && definition.name.trim() === "") {
    throw new Error("Function definition name must not be empty");
  }

  if ("events" in definition) {
    if (definition.routes !== undefined && definition.routes.length > 0) {
      throw new VokeConfigError(
        "Event Source Functions cannot define HTTP routes in v1."
      );
    }

    if (definition.output !== undefined) {
      throw new VokeConfigError(
        "Event Source Functions cannot define an output schema because Voke owns the event response contract."
      );
    }

    return {
      ...definition,
      key: "",
      kind: "event",
      routes: [],
    };
  }

  if ("handler" in definition) {
    return {
      ...definition,
      key: "",
      kind: "invokable",
      routes: definition.routes ?? [],
    };
  }

  return {
    ...definition,
    key: "",
    kind: "route",
    routes: definition.routes ?? [],
  };
}

export const fn = defineFunction;

export const http = <
  const TRoutes extends AnyRouteDefinition | readonly AnyRouteDefinition[],
>(
  definition: HttpFunctionDefinitionInput<TRoutes>
): RouteFunctionDefinition<string, RouteInputList<TRoutes>> => {
  const routes = (Array.isArray(definition.routes)
    ? definition.routes
    : [definition.routes]) as unknown as RouteInputList<TRoutes>;

  return Object.freeze({
    authorizer: definition.authorizer,
    authorizers: definition.authorizers,
    key: "",
    kind: "route",
    name: definition.name,
    routes: Object.freeze([...routes]) as unknown as RouteInputList<TRoutes>,
    synthesis: definition.synthesis,
  });
};

const queueInputs = (queues: SqsQueueListInput): readonly SqsQueueInput[] =>
  Array.isArray(queues) ? queues : [queues as SqsQueueInput];

const eventSourceFromQueueInput = (
  queue: SqsQueueInput,
  options: SqsEventSourceOptions
): SqsEventSourceDefinition => {
  if (typeof queue === "string") {
    return sqsEventSource(queue, options);
  }

  const { queue: queueName, ...queueOptions } = queue;

  return sqsEventSource(queueName, {
    ...options,
    ...queueOptions,
  });
};

export const sqs = <
  const TMessageSchema extends AnyStandardSchema,
  const TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
>(
  definition: SqsFunctionDefinitionInput<TMessageSchema, TInvalidMessageBody>
): EventFunctionDefinition<
  string,
  SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>
> => {
  if (definition.queue !== undefined && definition.queues !== undefined) {
    throw new VokeConfigError("Pass either queue or queues to sqs(), not both");
  }

  if (definition.queue === undefined && definition.queues === undefined) {
    throw new VokeConfigError("sqs() requires queue or queues");
  }

  const options = {
    batchSize: definition.batchSize ?? 10,
    enabled: definition.enabled,
    maxBatchingWindowSeconds: definition.maxBatchingWindowSeconds,
  };
  const queues =
    definition.queue === undefined
      ? queueInputs(definition.queues as SqsQueueListInput)
      : [definition.queue];

  return Object.freeze({
    events: Object.freeze(
      queues.map((queue) => eventSourceFromQueueInput(queue, options))
    ),
    handler: definition.handler,
    input: sqsMessageBatch(definition.message, {
      invalidMessageBody:
        definition.invalidMessageBody ?? ("fail" as TInvalidMessageBody),
    }),
    key: "",
    kind: "event",
    name: definition.name,
    routes: [],
    synthesis: definition.synthesis,
  });
};

const findRoute = (
  functions: Record<string, AnyFunctionDefinition>,
  method: RouteMethod,
  path: string
): AnyRouteDefinition | undefined => {
  for (const definition of Object.values(functions)) {
    if (definition.routes === undefined || definition.routes.length === 0) {
      continue;
    }

    const route = definition.routes?.find(
      (candidate) => candidate.method === method && candidate.path === path
    );

    if (route !== undefined) {
      return route;
    }
  }

  return undefined;
};

export const mountFunctionRoutes = (
  app: Hono<VokeEnv>,
  registry: FunctionRegistry | FunctionRegistryInput
): void => {
  for (const [key, definition] of Object.entries(registry)) {
    if (
      key === "invoke" ||
      key === "route" ||
      definition.routes === undefined ||
      definition.routes.length === 0
    ) {
      continue;
    }

    for (const route of definition.routes) {
      mountRoute(app, route, definition, registry);
    }
  }
};

export const assertUniqueFunctionRoutes = (
  registry: FunctionRegistry | FunctionRegistryInput
): void => {
  const routes = new Map<string, string>();

  for (const [key, definition] of Object.entries(registry)) {
    if (
      key === "invoke" ||
      key === "route" ||
      definition.routes === undefined ||
      definition.routes.length === 0
    ) {
      continue;
    }

    for (const route of definition.routes) {
      const routeKey = `${route.method} ${route.path}`;
      const previousKey = routes.get(routeKey);

      if (previousKey !== undefined) {
        throw new VokeConfigError(
          `Duplicate Gateway route ${routeKey} in functions "${previousKey}" and "${key}". HTTP method/path pairs must be unique across Gateway Functions.`
        );
      }

      routes.set(routeKey, key);
    }
  }
};

const routeParamKeys = (path: string): string[] =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/gu)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined);

const schemaObjectKeys = (schema: unknown): readonly string[] | undefined => {
  if (typeof schema !== "object" || schema === null || !("~voke" in schema)) {
    return undefined;
  }

  const metadata = (schema as { "~voke"?: { keys?: readonly string[] } })[
    "~voke"
  ];

  return metadata?.keys;
};

export const assertRouteParamSchemas = (
  registry: FunctionRegistry | FunctionRegistryInput
): void => {
  for (const definition of Object.values(registry)) {
    if (definition.routes === undefined || definition.routes.length === 0) {
      continue;
    }

    for (const route of definition.routes) {
      const expectedKeys = routeParamKeys(route.path);
      const schemaKeys = schemaObjectKeys(route.params);

      if (schemaKeys === undefined) {
        continue;
      }

      const expected = expectedKeys.toSorted();
      const actual = [...schemaKeys].toSorted();

      if (expected.join("\0") !== actual.join("\0")) {
        throw new VokeConfigError(
          `Route ${route.method} ${route.path} params schema expects ${actual.map((key) => JSON.stringify(key)).join(", ")}, but path defines ${expected.map((key) => JSON.stringify(key)).join(", ")}`
        );
      }
    }
  }
};

const color = {
  bold: "\u001B[1m",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  reset: "\u001B[0m",
} as const;

const colorize = (value: string, ...codes: string[]): string =>
  `${codes.join("")}${value}${color.reset}`;

const formatEventSourceSummary = (eventSource: EventSourceDefinition): string =>
  [
    colorize(eventSource.source.toUpperCase(), color.green),
    colorize(eventSource.queue, color.bold),
    colorize(
      `batchSize=${eventSource.options.batchSize ?? "-"} maxBatchingWindowSeconds=${eventSource.options.maxBatchingWindowSeconds ?? "-"} enabled=${eventSource.options.enabled ?? true}`,
      color.dim
    ),
  ].join(" ");

const routeUrl = (path: string): string | undefined => {
  const origin = Bun.env.VOKE_DEV_ORIGIN;

  if (origin === undefined) {
    return undefined;
  }

  return new URL(path, origin).toString();
};

const formatRouteSummary = (route: AnyRouteDefinition): string => {
  const url = routeUrl(route.path);
  const formattedRoute = `${colorize(route.method, color.green)} ${route.path}`;

  return `    ${formattedRoute}${url === undefined ? "" : ` ${colorize("->", color.dim)} ${colorize(url, color.cyan)}`}`;
};

const devOrigin = (): string =>
  (Bun.env.VOKE_DEV_ORIGIN ?? "http://localhost:3000").replace(/[/]+$/u, "");

const devReadyMs = (): number => {
  const startedAt = Number(Bun.env.VOKE_DEV_STARTED_AT);

  if (!Number.isFinite(startedAt)) {
    return 0;
  }

  return Math.max(0, Date.now() - startedAt);
};

const formatDevHeader = (): string =>
  [
    `  ${colorize("VOKE", color.cyan, color.bold)} ${colorize(`v${packageJson.version}`, color.dim)}  ${colorize(`ready in ${devReadyMs()} ms`, color.green)}`,
    "",
    `  ${colorize("➜", color.green)}  ${colorize("Local:", color.bold)}   ${devOrigin()}/`,
    `  ${colorize("➜", color.green)}  ${colorize("Network:", color.bold)} use --hostname 0.0.0.0 to expose`,
  ].join("\n");

export const formatDevFunctionSummary = (
  registry: FunctionRegistry | FunctionRegistryInput
): string => {
  const routeFunctions: string[] = [];
  const invokableFunctions: string[] = [];
  const eventFunctions: string[] = [];

  for (const [key, definition] of Object.entries(registry)) {
    if (key === "invoke" || key === "route" || key === "sendEvent") {
      continue;
    }

    if (definition.kind === "event") {
      const eventDefinition = definition as EventFunctionDefinition;

      eventFunctions.push(
        [
          `  ${colorize(key, color.bold)}`,
          ...eventDefinition.events.map(
            (event) => `    ${formatEventSourceSummary(event)}`
          ),
        ].join("\n")
      );
      continue;
    }

    if (definition.routes !== undefined && definition.routes.length > 0) {
      const routeDefinition = definition as RouteFunctionDefinition;

      routeFunctions.push(
        [
          `  ${colorize(key, color.bold)}`,
          ...routeDefinition.routes.map(formatRouteSummary),
        ].join("\n")
      );
      continue;
    }

    if (definition.kind === "invokable") {
      invokableFunctions.push(
        `  ${colorize(key, color.bold)}\n    ${colorize("internal", color.dim)}`
      );
    }
  }

  const summarySections: { lines: string[]; title: string }[] = [
    { lines: routeFunctions, title: "Route Functions" },
    { lines: invokableFunctions, title: "Invokable Functions" },
    { lines: eventFunctions, title: "Event Functions" },
  ];
  const sections = summarySections
    .filter((section) => section.lines.length > 0)
    .map(
      (section) =>
        `${colorize(section.title, color.cyan, color.bold)}\n${section.lines.join("\n")}`
    );

  return [formatDevHeader(), ...sections].join("\n\n").trimEnd();
};

export const defineFunctions = <const TRegistry extends FunctionRegistryInput>(
  registry: TRegistry
): FunctionRegistry<TRegistry> => {
  const functions = {} as Record<string, AnyFunctionDefinition>;

  for (const [key, definition] of Object.entries(registry)) {
    if (reservedFunctionRegistryKeys.has(key)) {
      throw new VokeConfigError(`Function Registry key "${key}" is reserved`);
    }

    functions[key] = {
      ...definition,
      key,
    };
    Object.freeze(functions[key]);
  }

  Object.defineProperty(functions, "invoke", {
    enumerable: false,
    value: ((
      functionName: string,
      payload?: unknown,
      options?: InvokeOptions
    ) => {
      const definition = functions[functionName];
      if (definition?.kind === "event" || definition?.kind === "route") {
        return Promise.reject(
          new InvokeError(
            `Function "${functionName}" cannot be invoked with functions.invoke`,
            {
              code: "MISSING_FUNCTION",
              functionName,
            }
          )
        );
      }

      return invokeRegistryFunction(
        functions,
        definition as InvokableFunctionDefinition | undefined,
        payload,
        options
      );
    }) as FunctionRegistryInvoke<FunctionRegistry<TRegistry>>,
  });
  Object.defineProperty(functions, "sendEvent", {
    enumerable: false,
    value: ((functionName: string, event: EventInvocationInput) => {
      const definition = functions[functionName];

      if (definition?.kind !== "event") {
        return Promise.reject(
          new InvokeError(
            `Function "${functionName}" cannot receive events with functions.sendEvent`,
            {
              code: "MISSING_FUNCTION",
              functionName,
            }
          )
        );
      }

      return sendEventToFunction(definition as EventFunctionDefinition, event);
    }) as FunctionRegistrySendEvent<FunctionRegistry<TRegistry>>,
  });
  Object.defineProperty(functions, "route", {
    enumerable: false,
    value: ((method: RouteMethod, path: string, request: unknown) => {
      const route = findRoute(functions, method, path);

      if (route === undefined) {
        throw new InvokeError(`Route not found: ${method} ${path}`, {
          code: "MISSING_FUNCTION",
          functionName: `${method} ${path}`,
        });
      }

      return runRoute(
        route,
        (request ?? {}) as RouteInvocationInput<AnyRouteDefinition>
      );
    }) as FunctionRegistryRoute<FunctionRegistry<TRegistry>>,
  });

  return Object.freeze(functions) as FunctionRegistry<TRegistry>;
};

export const createFunctions = defineFunctions;

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
