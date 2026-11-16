import { AsyncLocalStorage } from "node:async_hooks";

import type { Context, Hono, MiddlewareHandler } from "hono";

import packageJson from "../package.json";
import type {
  AuthorizerRegistryInput,
  AuthorizerRequest,
  RequestAuthorizerFunctionDefinition,
  RequestAuthorizerHandler,
} from "./authorizers";
import type { VokeEnv } from "./context";
import { VokeConfigError, VokeResourceBindingError } from "./errors";
import { json, jsonError } from "./http";
import type {
  VokeModelProviderExtensionRecord,
  VokeModelRecord,
} from "./model";
import type { FunctionExecution, FunctionWrap } from "./plugin";
import type {
  ProviderInvokeCapability,
  ProviderInvokeTarget,
  VokeProvider,
} from "./provider";
import { error as responseError } from "./response";
import { Voke } from "./route-builder";
import { readEnv, sleep } from "./runtime-env";
import { formatValidationIssue, readStandardResult } from "./standard-schema";
import type {
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
  ValidationIssue,
} from "./standard-schema";
import {
  createRuntimeVariableCache,
  createRuntimeVariables,
  loadRuntimeVariablesBeforeHandler,
} from "./variables";
import type {
  RuntimeVariableCache,
  RuntimeVariableCatalog,
  RuntimeVariableHandles,
  RuntimeVariableOverrides,
  RuntimeVariableProvider,
} from "./variables";

export type {
  StandardSchemaFailureResult,
  StandardSchemaIssue,
  StandardSchemaPathSegment,
  StandardSchemaResult,
  StandardSchemaSuccessResult,
  StandardSchemaV1,
  ValidationIssue,
} from "./standard-schema";

export type InvokeMode = "sync" | "async";
export type InvokeRuntime = "local" | "aws";

export type InvokeTrace = Record<string, string | number | boolean | undefined>;
export type InvokeErrorCode =
  | "INVALID_OPTIONS"
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
  issues?: readonly ValidationIssue[];
  requestId?: string;
  statusCode?: number;
}

export class InvokeError extends Error {
  code: InvokeErrorCode;
  functionName?: string;
  issues?: readonly ValidationIssue[];
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

export interface InvokeContext<
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResource extends string = string,
> {
  functionName: string;
  /**
   * The binding value of a resource this Function links in `resources` (a table name, a queue
   * URL, a topic ARN, ...). Throws VokeResourceBindingError for a resource it does not link.
   */
  // Method syntax on purpose: its parameter is compared bivariantly, so a handler annotated with
  // the plain `InvokeContext` still fits a Function whose `resources` narrow the key.
  resource(key: TResource): string;
  trace: InvokeTrace;
  variables: RuntimeVariableHandles<TVariables>;
}

export interface AsyncInvokeResult {
  accepted: true;
  /** The execution the Provider started, when its transport reports one. */
  executionId?: string;
  requestId?: string;
}

/**
 * One trigger of an Event Source Function. Provider packages author it through their own
 * authoring helpers; core knows no source by name.
 */
export interface EventSourceDefinition {
  /** The Event Source type, named by the Provider package that authored it. */
  readonly source: string;
  /** The Voke resource key the source reads from, when it has one. */
  readonly resource?: string;
  /** Source settings. Voke copies them to the model untouched; the Provider validates them. */
  readonly properties: VokeModelRecord;
}

export interface FunctionSynthesisConfig {
  entrypoint?: string;
  environment?: Record<string, string>;
  handler?: string;
  /** Memory for this Function, in MB. Overrides `runtime.memory`. */
  memory?: number;
  /**
   * Provider-specific settings, keyed by Provider name. Voke copies them to the model untouched;
   * the Provider validates and applies them. Each Provider package exports a builder for its record.
   */
  provider?: Record<string, VokeModelProviderExtensionRecord>;
  /** Maximum run time for this Function, in seconds. Overrides `runtime.timeout`. */
  timeout?: number;
}

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

type FunctionKind = "authorizer" | "event" | "invokable" | "route";
export type RouteAuthorizerReference = "none" | string;

export interface RouteAuthContext {
  readonly context: Record<string, unknown>;
  /** "lambda" for Request/Lambda authorizer results, "jwt" for verified JWT claims. */
  readonly source: "jwt" | "lambda";
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

/** Query string values or headers without a schema: plain strings, header names lower-case. */
type RouteRecord = Record<string, string | undefined>;

export interface RouteRequest<
  TBody = undefined,
  TParams = Record<string, string>,
  TQuery = RouteRecord,
  THeaders = RouteRecord,
> {
  readonly auth: RouteAuthContext;
  readonly body: TBody;
  readonly headers: THeaders;
  readonly params: TParams;
  readonly query: TQuery;
  readonly raw: Request;
  readonly request: Request;
}

export type RouteHandler<
  TBody,
  TParams,
  TQuery,
  THeaders,
  TResult,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResource extends string = string,
> = (
  request: RouteRequest<TBody, TParams, TQuery, THeaders>,
  context: InvokeContext<TVariables, TResource>
) => RouteReturn<TResult>;

// A slot without a schema infers to the wide `StandardSchemaV1<unknown, unknown>`, so a schema
// whose two sides are both `unknown` cannot be told apart from "no schema" and keeps the fallback.
// A schema that types either side is read as declared, even when the other side is `unknown`.
type IsUntypedSchema<TSchema> =
  unknown extends StandardSchemaInput<TSchema>
    ? unknown extends StandardSchemaOutput<TSchema>
      ? true
      : false
    : false;

type RouteSchemaOutput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? IsUntypedSchema<TSchema> extends true
    ? TFallback
    : StandardSchemaOutput<TSchema>
  : TFallback;

type RouteSchemaInput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? IsUntypedSchema<TSchema> extends true
    ? TFallback
    : StandardSchemaInput<TSchema>
  : TFallback;

// With an `output` schema the handler returns what that schema accepts; without one, anything.
// A `Response` is always allowed (`RouteReturn`) and is not validated.
type RouteHandlerResult<TOutputSchema, TResult> =
  TOutputSchema extends AnyStandardSchema
    ? StandardSchemaInput<TOutputSchema>
    : TResult;

/** Documentation for a route. The Gateway ignores it at run time. */
export interface RouteMeta {
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly operationId?: string;
  readonly deprecated?: boolean;
  /** Leave the route out of generated documentation. */
  readonly hidden?: boolean;
}

export interface RouteDefinitionInput<
  _TMethod extends RouteMethod,
  _TPath extends string,
  TBodySchema extends AnyStandardSchema | undefined,
  TParamsSchema extends AnyStandardSchema | undefined,
  TQuerySchema extends AnyStandardSchema | undefined,
  THeadersSchema extends AnyStandardSchema | undefined,
  TOutputSchema extends AnyStandardSchema | undefined,
  TResult,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResource extends string = string,
> {
  readonly authorizer?: RouteAuthorizerReference;
  readonly body?: TBodySchema;
  readonly handler: RouteHandler<
    RouteSchemaOutput<TBodySchema, undefined>,
    RouteSchemaOutput<TParamsSchema, Record<string, string>>,
    RouteSchemaOutput<TQuerySchema, RouteRecord>,
    RouteSchemaOutput<THeadersSchema, RouteRecord>,
    RouteHandlerResult<TOutputSchema, TResult>,
    TVariables,
    TResource
  >;
  readonly headers?: THeadersSchema;
  readonly meta?: RouteMeta;
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
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResource extends string = string,
> extends RouteDefinitionInput<
  TMethod,
  TPath,
  TBodySchema,
  TParamsSchema,
  TQuerySchema,
  THeadersSchema,
  TOutputSchema,
  TResult,
  TVariables,
  TResource
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
    unknown,
    RuntimeVariableCatalog
  >,
  "handler"
> & {
  readonly handler: unknown;
};

export interface RouteInvocationInput<TRoute> {
  readonly auth?: RouteAuthContext;
  readonly body?: TRoute extends { readonly body?: infer TSchema }
    ? RouteSchemaInput<TSchema, undefined>
    : undefined;
  readonly headers?: TRoute extends { readonly headers?: infer TSchema }
    ? RouteSchemaInput<TSchema, Record<string, string>>
    : Record<string, string>;
  readonly params?: TRoute extends { readonly params?: infer TSchema }
    ? RouteSchemaInput<TSchema, Record<string, string>>
    : Record<string, string>;
  readonly query?: TRoute extends { readonly query?: infer TSchema }
    ? RouteSchemaInput<TSchema, Record<string, string>>
    : Record<string, string>;
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

export type FunctionHandler<
  TPayload,
  TResult,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResource extends string = string,
> = (
  payload: TPayload,
  context: InvokeContext<TVariables, TResource>
) => TResult | Promise<TResult>;

export type EventFunctionHandler<
  TPayload,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResult = unknown,
  TResource extends string = string,
> = (
  payload: TPayload,
  context: InvokeContext<TVariables, TResource>
) => TResult | Promise<TResult>;

export interface BaseFunctionDefinition<
  TKey extends string = string,
  TKind extends FunctionKind = FunctionKind,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  readonly key: TKey;
  readonly kind: TKind;
  readonly name?: string;
  /** Resource Links: the resource keys this Function reads through `context.resource`. */
  readonly resources?: readonly string[];
  readonly synthesis?: FunctionSynthesisConfig;
  readonly variables?: TVariables;
}

export type InvokableFunctionDefinition<
  TKey extends string = string,
  TInputSchema extends AnyStandardSchema | undefined =
    | AnyStandardSchema
    | undefined,
  TOutputSchema extends AnyStandardSchema = AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> = BaseFunctionDefinition<TKey, "invokable", TVariables> & {
  readonly handler: FunctionHandler<
    TInputSchema extends AnyStandardSchema
      ? StandardSchemaOutput<TInputSchema>
      : undefined,
    | StandardSchemaInput<TOutputSchema>
    | Promise<StandardSchemaInput<TOutputSchema>>,
    TVariables
  >;
  readonly output: TOutputSchema;
} & (TInputSchema extends AnyStandardSchema
    ? { readonly input: TInputSchema }
    : { readonly input?: undefined });

export type RouteFunctionDefinition<
  TKey extends string = string,
  TRoutes extends readonly AnyRouteDefinition[] = readonly AnyRouteDefinition[],
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> = BaseFunctionDefinition<TKey, "route", TVariables> & {
  readonly authorizer?: string;
  readonly authorizers?: AuthorizerRegistryInput;
  readonly routes: TRoutes;
};

export type EventFunctionDefinition<
  TKey extends string = string,
  TInputSchema extends AnyStandardSchema = AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResult = unknown,
> = BaseFunctionDefinition<TKey, "event", TVariables> & {
  readonly events: readonly EventSourceDefinition[];
  readonly handler: EventFunctionHandler<
    StandardSchemaOutput<TInputSchema>,
    TVariables,
    TResult
  >;
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
  readonly handler?: unknown;
  readonly input?: AnyStandardSchema;
  readonly output?: AnyStandardSchema;
  readonly routes?: readonly AnyRouteDefinition[];
  readonly variables?: RuntimeVariableCatalog;
};

interface FunctionDefinitionInputBase {
  name?: string;
  resources?: readonly string[];
  routes?: readonly AnyRouteDefinition[];
  synthesis?: FunctionSynthesisConfig;
  variables?: RuntimeVariableCatalog;
}

type InvokableFunctionWithInputDefinitionInput<
  TInputSchema extends AnyStandardSchema,
  TOutputSchema extends AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> = FunctionDefinitionInputBase & {
  handler: FunctionHandler<
    StandardSchemaOutput<TInputSchema>,
    | StandardSchemaInput<TOutputSchema>
    | Promise<StandardSchemaInput<TOutputSchema>>,
    TVariables,
    TResources[number]
  >;
  input: TInputSchema;
  output: TOutputSchema;
  resources?: TResources;
  variables?: TVariables;
};

type InvokableZeroInputFunctionDefinitionInput<
  TOutputSchema extends AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> = FunctionDefinitionInputBase & {
  handler: FunctionHandler<
    undefined,
    | StandardSchemaInput<TOutputSchema>
    | Promise<StandardSchemaInput<TOutputSchema>>,
    TVariables,
    TResources[number]
  >;
  output: TOutputSchema;
  resources?: TResources;
  variables?: TVariables;
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
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> extends Omit<FunctionDefinitionInputBase, "resources" | "routes"> {
  readonly authorizer?: string;
  readonly authorizers?: AuthorizerRegistryInput;
  /** Resource Links: every route of this Function may read these resources. */
  readonly resources?: TResources;
  readonly routes:
    | TRoutes
    | ((route: Voke<TVariables, TResources[number]>) => TRoutes);
  readonly variables?: TVariables;
}

export type FunctionRegistryInput = Record<string, AnyFunctionDefinition>;

type FunctionDefinitionWithKey<
  TDefinition,
  TKey extends string,
> = TDefinition extends {
  readonly kind: "authorizer";
}
  ? TDefinition extends {
      readonly context?: infer TContext;
      readonly variables?: infer TVariables;
    }
    ? TContext extends StandardSchemaV1<unknown, infer TContextOutput>
      ? TContextOutput extends Record<string, unknown>
        ? TVariables extends RuntimeVariableCatalog
          ? RequestAuthorizerFunctionDefinition<
              TKey,
              TContextOutput,
              TVariables
            >
          : RequestAuthorizerFunctionDefinition<
              TKey,
              TContextOutput,
              Record<never, never>
            >
        : never
      : TVariables extends RuntimeVariableCatalog
        ? RequestAuthorizerFunctionDefinition<
            TKey,
            Record<string, unknown>,
            TVariables
          >
        : RequestAuthorizerFunctionDefinition<
            TKey,
            Record<string, unknown>,
            Record<never, never>
          >
    : RequestAuthorizerFunctionDefinition<TKey>
  : TDefinition extends {
        readonly events: readonly EventSourceDefinition[];
        readonly handler: (...args: never[]) => infer THandlerResult;
        readonly input: infer TInputSchema;
        readonly kind: "event";
        readonly variables?: infer TVariables;
      }
    ? TInputSchema extends AnyStandardSchema
      ? TVariables extends RuntimeVariableCatalog
        ? EventFunctionDefinition<
            TKey,
            TInputSchema,
            TVariables,
            Awaited<THandlerResult>
          >
        : EventFunctionDefinition<
            TKey,
            TInputSchema,
            Record<never, never>,
            Awaited<THandlerResult>
          >
      : never
    : TDefinition extends {
          readonly input: infer TInputSchema;
          readonly kind: "invokable";
          readonly output: infer TOutputSchema;
          readonly variables?: infer TVariables;
        }
      ? TInputSchema extends AnyStandardSchema
        ? TOutputSchema extends AnyStandardSchema
          ? TVariables extends RuntimeVariableCatalog
            ? InvokableFunctionDefinition<
                TKey,
                TInputSchema,
                TOutputSchema,
                TVariables
              >
            : InvokableFunctionDefinition<
                TKey,
                TInputSchema,
                TOutputSchema,
                Record<never, never>
              >
          : never
        : never
      : TDefinition extends {
            readonly kind: "invokable";
            readonly output: infer TOutputSchema;
            readonly variables?: infer TVariables;
          }
        ? TOutputSchema extends AnyStandardSchema
          ? TVariables extends RuntimeVariableCatalog
            ? InvokableFunctionDefinition<
                TKey,
                undefined,
                TOutputSchema,
                TVariables
              >
            : InvokableFunctionDefinition<
                TKey,
                undefined,
                TOutputSchema,
                Record<never, never>
              >
          : never
        : TDefinition extends RouteFunctionDefinition<
              string,
              infer TRoutes,
              infer TVariables
            >
          ? TVariables extends RuntimeVariableCatalog
            ? RouteFunctionDefinition<TKey, TRoutes, TVariables>
            : RouteFunctionDefinition<TKey, TRoutes, Record<never, never>>
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
  /** A caller-chosen name that makes starting the execution idempotent. */
  executionName?: string;
  functionName: string;
  invocationType: "RequestResponse" | "Event";
  /**
   * The `{ payload, trace }` envelope for `runtime: "aws"`; the bare parsed payload for a
   * Function the Provider routes through its invoke target.
   */
  payload:
    | {
        payload: TPayload;
        trace: InvokeTrace;
      }
    | TPayload;
}

export interface InvokeTransportResponse<TResult = unknown> {
  /** The execution the invocation started, when the platform reports one. */
  executionId?: string;
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
  /**
   * Names the execution so starting it is idempotent. Only for Functions the Provider accepts it
   * for (its invoke capability's `acceptsExecutionName`); an in-process run ignores it, and any
   * other Function rejects with `INVALID_OPTIONS`.
   */
  executionName?: string;
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
    readonly input: AnyStandardSchema;
    readonly kind: "event";
  }
    ? TKey
    : never;
}[keyof TRegistry];

type EventFunctionInput<TFunction> = TFunction extends {
  readonly input: infer TInputSchema;
}
  ? StandardSchemaInput<TInputSchema>
  : never;

type EventFunctionResult<TFunction> = TFunction extends {
  readonly handler: (...args: never[]) => infer THandlerResult;
}
  ? Awaited<THandlerResult>
  : unknown;

/**
 * Event Invocation: delivers an event to an Event Source Function. The event shape is the
 * Function's input schema input; the result is whatever its handler returns.
 */
export type FunctionRegistrySendEvent<TRegistry> = <
  TKey extends EventFunctionKey<TRegistry>,
>(
  functionName: TKey,
  event: EventFunctionInput<TRegistry[TKey]>
) => Promise<EventFunctionResult<TRegistry[TKey]>>;

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
interface FunctionRegistryActivation {
  activationKey: string;
  invoke?: ProviderInvokeCapability;
  variableCache: RuntimeVariableCache;
  unregisteredVariableProviders: "defer" | "error";
  variableOverrides?: RuntimeVariableOverrides;
  variableProviders: readonly RuntimeVariableProvider[];
  /** Resource key → its binding variable name. Absent when the registry has no config. */
  resourceBindings?: Readonly<Record<string, string>>;
  /** Plugin Function Wraps, outermost first. Absent when no Plugin wraps. */
  wraps?: readonly PluginFunctionWrap[];
}

/** A Function Wrap with the name of the Plugin that declared it. */
export interface PluginFunctionWrap {
  readonly plugin: string;
  readonly wrap: FunctionWrap;
}

const activatedFunctionRegistries = new WeakMap<
  object,
  FunctionRegistryActivation
>();
const activatedFunctionDefinitions = new WeakMap<
  BaseFunctionDefinition,
  FunctionRegistryActivation
>();
const reservedFunctionRegistryKeys = new Set(["invoke", "route", "sendEvent"]);

const functionKinds: ReadonlySet<string> = new Set<FunctionKind>([
  "authorizer",
  "event",
  "invokable",
  "route",
]);

const isFunctionDefinition = (value: unknown): value is AnyFunctionDefinition =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  "kind" in value &&
  typeof value.kind === "string" &&
  functionKinds.has(value.kind);

/**
 * The Function definitions of a registry, in declaration order. Membership is decided by shape,
 * so registry methods (`invoke`, `route`, `sendEvent`) are never entries.
 */
export const functionRegistryEntries = (
  registry: FunctionRegistry | FunctionRegistryInput | object
): [string, AnyFunctionDefinition][] =>
  Object.entries(registry).filter(
    (entry): entry is [string, AnyFunctionDefinition] =>
      isFunctionDefinition(entry[1])
  );

const currentTrace = (): InvokeTrace => traceStack.at(-1) ?? {};

export const activateFunctionRegistry = (
  registry: object,
  activationKey: string,
  options: {
    /** The Provider's invoke capability; its `target` can route Functions through its transport. */
    invoke?: ProviderInvokeCapability;
    /** Resource key → its binding variable name, from the config's resources. */
    resourceBindings?: Readonly<Record<string, string>>;
    variableOverrides?: RuntimeVariableOverrides;
    variableProviders?: readonly RuntimeVariableProvider[];
    /** Plugin Function Wraps around every handler call, outermost first. */
    wraps?: readonly PluginFunctionWrap[];
  } = {}
): void => {
  const previousActivation = activatedFunctionRegistries.get(registry);

  if (
    previousActivation !== undefined &&
    previousActivation.activationKey !== activationKey
  ) {
    throw new VokeConfigError(
      "Function Registry is already activated with a different Gateway context"
    );
  }

  const variableProviders = options.variableProviders ?? [];
  const activation: FunctionRegistryActivation = {
    activationKey,
    invoke: options.invoke,
    ...(options.resourceBindings === undefined
      ? {}
      : { resourceBindings: options.resourceBindings }),
    // Without any provider (no configured Provider, no explicit providers), Runtime Variables
    // can still resolve from overrides and the environment, so provider checks wait for load.
    unregisteredVariableProviders:
      variableProviders.length === 0 ? "defer" : "error",
    variableCache:
      previousActivation?.variableCache ?? createRuntimeVariableCache(),
    variableOverrides: options.variableOverrides,
    variableProviders,
    ...(options.wraps === undefined || options.wraps.length === 0
      ? {}
      : { wraps: options.wraps }),
  };

  activatedFunctionRegistries.set(registry, activation);

  for (const [, definition] of functionRegistryEntries(registry)) {
    activatedFunctionDefinitions.set(
      definition as BaseFunctionDefinition,
      activation
    );
  }
};

const resolveTrace = (options: InvokeOptions): InvokeTrace => ({
  ...currentTrace(),
  ...options.trace,
});

const resolveRuntime = (options: InvokeOptions): InvokeRuntime => {
  if (options.runtime !== undefined) {
    return options.runtime;
  }

  return readEnv("VOKE_INVOKE_RUNTIME") === "aws" ? "aws" : "local";
};

const deployedName = (definition: BaseFunctionDefinition): string =>
  definition.name ?? definition.key;

/** The Plugin Function Wraps of an activated definition; undefined when there are none. */
const functionWraps = (
  definition: object
): readonly PluginFunctionWrap[] | undefined =>
  activatedFunctionDefinitions.get(definition as BaseFunctionDefinition)?.wraps;

// Composes the wraps outermost first around `run`. Callers check `functionWraps` first, so a
// Function without wraps calls its handler directly, with no extra closure or promise.
const runWrapped = async (
  wraps: readonly PluginFunctionWrap[],
  execution: FunctionExecution,
  run: () => unknown
): Promise<unknown> => {
  const dispatch = async (index: number): Promise<unknown> => {
    const entry = wraps[index];

    if (entry === undefined) {
      return await run();
    }

    let called = false;

    return await entry.wrap(execution, async () => {
      if (called) {
        throw new Error(
          `Plugin "${entry.plugin}" called next() more than once for Function "${execution.functionKey}"`
        );
      }

      called = true;

      return await dispatch(index + 1);
    });
  };

  return await dispatch(0);
};

interface EntryFunction {
  readonly entry: BaseFunctionDefinition;
}

// The Function a handler call entered the process through. An in-process `functions.invoke` runs
// with that Function's deployed role and environment, so a read must be linked by it as well.
const entryFunction = new AsyncLocalStorage<EntryFunction | undefined>();

/** Runs `run` with `definition` as the entry Function, unless an entry is already set. */
const runAsEntry = <TResult>(
  definition: BaseFunctionDefinition,
  run: () => TResult
): TResult =>
  entryFunction.getStore() === undefined
    ? entryFunction.run({ entry: definition }, run)
    : run();

/** Runs `run` outside every entry: the invocation leaves the process, so it starts a new one. */
const runOutsideEntry = <TResult>(run: () => TResult): TResult =>
  entryFunction.run(undefined, run);

const notLinkedError = (
  functionKey: string,
  resource: string
): VokeResourceBindingError =>
  new VokeResourceBindingError(
    `Function "${functionKey}" does not link resource "${resource}". Add it to the Function: resources: ["${resource}"]`
  );

const isLinked = (
  definition: BaseFunctionDefinition,
  resource: string
): boolean => definition.resources?.includes(resource) === true;

// Checks run when the handler reads, so the entry Function is the one of that call.
const readResource = (
  definition: BaseFunctionDefinition,
  activation: FunctionRegistryActivation | undefined,
  resource: string
): string => {
  if (!isLinked(definition, resource)) {
    throw notLinkedError(definition.key, resource);
  }

  const entry = entryFunction.getStore()?.entry;

  if (
    entry !== undefined &&
    entry !== definition &&
    !isLinked(entry, resource)
  ) {
    throw new VokeResourceBindingError(
      `Function "${definition.key}" reads resource "${resource}" while running in-process inside Function "${entry.key}", which does not link it. An in-process invocation runs with the caller's role: add resources: ["${resource}"] to "${entry.key}"`
    );
  }

  if (activation?.resourceBindings === undefined) {
    throw new VokeResourceBindingError(
      `Function "${definition.key}" reads resource "${resource}", but its Function Registry was activated without a config, so Voke cannot resolve the binding. Create the Gateway with the config: voke(functions, { config })`
    );
  }

  const envName = activation.resourceBindings[resource];

  // The model rejects a link to an unknown resource, so this is a link the config lacks.
  if (envName === undefined) {
    throw notLinkedError(definition.key, resource);
  }

  const value = readEnv(envName);

  if (value === undefined || value === "") {
    throw new VokeResourceBindingError(`Missing resource binding: ${envName}`);
  }

  return value;
};

const createInvokeContext = <TVariables extends RuntimeVariableCatalog>(
  definition: BaseFunctionDefinition<string, FunctionKind, TVariables>,
  options: InvokeOptions
): InvokeContext<TVariables> => {
  const functionName = deployedName(definition);
  const activation = activatedFunctionDefinitions.get(definition);

  return {
    functionName,
    resource: (key) =>
      readResource(definition as BaseFunctionDefinition, activation, key),
    trace: resolveTrace(options),
    variables: createRuntimeVariables({
      cache: activation?.variableCache,
      functionKey: definition.key,
      overrides: activation?.variableOverrides,
      providers: activation?.variableProviders ?? [],
      unregisteredProviders: activation?.unregisteredVariableProviders,
      variables: definition.variables ?? ({} as TVariables),
    }),
  };
};

const parseWithSchema = async <TInput, TOutput>(
  schema: StandardSchemaV1<TInput, TOutput>,
  value: TInput,
  errorFactory: (
    message: string,
    cause?: unknown,
    issues?: readonly ValidationIssue[]
  ) => InvokeError
): Promise<TOutput> => {
  try {
    const result = readStandardResult(
      await schema["~standard"].validate(value)
    );

    if (result.ok) {
      return result.value;
    }

    throw errorFactory(
      result.issues.map(formatValidationIssue).join("; "),
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

// The keys a `@voke/schema` object exposes, for checks other validators cannot support.
const schemaObjectKeys = (schema: unknown): readonly string[] | undefined => {
  if (typeof schema !== "object" || schema === null || !("~voke" in schema)) {
    return undefined;
  }

  const metadata = (schema as { "~voke"?: { keys?: readonly string[] } })[
    "~voke"
  ];

  return metadata?.keys;
};

type RouteRequestPart = "body" | "headers" | "params" | "query";

interface RouteRequestErrorOptions extends InvokeErrorOptions {
  readonly part: RouteRequestPart;
  readonly status: 400 | 415;
}

/** The request does not fit the route: the client's mistake. Callers outside the Gateway see an InvokeError. */
// oxlint-disable-next-line eslint/max-classes-per-file -- an internal InvokeError subclass, kept beside the class it extends.
class RouteRequestError extends InvokeError {
  readonly part: RouteRequestPart;
  readonly status: 400 | 415;

  // oxlint-disable-next-line unicorn/custom-error-definition -- keeps the InvokeError name: functions.route callers see an InvokeError.
  constructor(message: string, options: RouteRequestErrorOptions) {
    super(message, options);
    this.part = options.part;
    this.status = options.status;
  }
}

const routeName = (route: AnyRouteDefinition): string =>
  `${route.method} ${route.path}`;

const parseRoutePart = async <TSchema extends AnyStandardSchema | undefined>(
  schema: TSchema,
  value: RouteSchemaInput<TSchema, unknown>,
  part: RouteRequestPart | "result",
  route: AnyRouteDefinition
): Promise<RouteSchemaOutput<TSchema, typeof value>> => {
  if (schema === undefined) {
    return value as RouteSchemaOutput<TSchema, typeof value>;
  }

  return (await parseWithSchema(schema, value, (message, cause, issues) => {
    const functionName = routeName(route);
    const errorMessage = `Invalid ${part} for ${functionName}: ${message}`;
    const prefixedIssues = issues?.map((issue) => ({
      ...issue,
      path: [part, ...(issue.path ?? [])],
    }));

    if (part === "result") {
      return new InvokeError(errorMessage, {
        cause,
        code: "INVALID_RESULT",
        functionName,
        issues: prefixedIssues,
      });
    }

    return new RouteRequestError(errorMessage, {
      cause,
      code: "INVALID_PAYLOAD",
      functionName,
      issues: prefixedIssues,
      part,
      status: 400,
    });
  })) as RouteSchemaOutput<TSchema, typeof value>;
};

// A repeated key is one value, joined with "," in order of appearance. Built from a Map so a key
// named "__proto__" becomes an ordinary own property.
const queryRecord = (url: string): Record<string, string> => {
  const values = new Map<string, string>();

  for (const [key, value] of new URL(url).searchParams) {
    const previous = values.get(key);
    values.set(key, previous === undefined ? value : `${previous},${value}`);
  }

  return Object.fromEntries(values);
};

// `Headers` already lower-cases names and combines repeated values.
const headerRecord = (
  headers: Headers | Record<string, unknown>
): Record<string, string> => {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers);
  }

  const values = new Map<string, string>();

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      values.set(name.toLowerCase(), String(value));
    }
  }

  return Object.fromEntries(values);
};

// A headers schema that names its keys receives only those: clients, proxies and API Gateway add
// headers the route never declared.
const headersForSchema = (
  schema: AnyStandardSchema | undefined,
  headers: Record<string, string>
): Record<string, string> => {
  const keys = schemaObjectKeys(schema);

  if (keys === undefined) {
    return headers;
  }

  const declared = new Set(keys);

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => declared.has(name))
  );
};

const jsonMediaType = /^application\/(?:[\w.-]+\+)?json$/u;

// A `body` schema means a JSON body. No body or an empty one is `undefined`.
const readJsonBody = async (
  route: AnyRouteDefinition,
  request: Request,
  readText: () => Promise<string>
): Promise<unknown> => {
  if (request.body === null) {
    return undefined;
  }

  const text = await readText();

  if (text === "") {
    return undefined;
  }

  const functionName = routeName(route);
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();

  if (mediaType === undefined || !jsonMediaType.test(mediaType)) {
    throw new RouteRequestError(
      `Unsupported content type for ${functionName}: send application/json`,
      { code: "INVALID_PAYLOAD", functionName, part: "body", status: 415 }
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // The parser's message differs between runtimes, so it never reaches the client.
    throw new RouteRequestError(
      `Invalid body for ${functionName}: Malformed JSON`,
      {
        cause: error,
        code: "INVALID_PAYLOAD",
        functionName,
        issues: [{ message: "Malformed JSON", path: ["body"] }],
        part: "body",
        status: 400,
      }
    );
  }
};

const createRouteRequest = async (
  route: AnyRouteDefinition,
  input: RouteInvocationInput<AnyRouteDefinition>,
  readText?: () => Promise<string>
): Promise<RouteRequest<unknown, unknown, unknown, unknown>> => {
  const headers = headerRecord(
    (input.headers as Record<string, unknown> | undefined) ??
      input.request?.headers ??
      {}
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
      headers: new Headers(headers),
      method: route.method,
    });
  const rawBody =
    input.body ??
    (route.body === undefined
      ? undefined
      : await readJsonBody(
          route,
          request,
          readText ?? (() => request.clone().text())
        ));
  const parsedBody = await parseRoutePart(route.body, rawBody, "body", route);
  const parsedHeaders = await parseRoutePart(
    route.headers,
    headersForSchema(route.headers, headers),
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
    input.query ?? queryRecord(request.url),
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

  return await parseRoutePart(route.output, value, "result", route);
};

const runRouteHandler = async (
  route: AnyRouteDefinition,
  request: RouteRequest<unknown, unknown, unknown, unknown>,
  definition?: AnyFunctionDefinition
): Promise<unknown> => {
  const context =
    definition === undefined
      ? {
          functionName: routeName(route),
          resource: (key: string): string => {
            throw notLinkedError(routeName(route), key);
          },
          trace: currentTrace(),
          variables: createRuntimeVariables({
            functionKey: routeName(route),
            providers: [],
            variables: {},
          }),
        }
      : createInvokeContext(definition, {});
  await loadRuntimeVariablesBeforeHandler(context.variables);
  const handler = route.handler as RouteHandler<
    never,
    never,
    never,
    never,
    unknown,
    RuntimeVariableCatalog
  >;
  const run = () =>
    handler(request as RouteRequest<never, never, never, never>, context);

  if (definition === undefined) {
    return await parseRouteOutput(route, await run());
  }

  const wraps = functionWraps(definition);
  const result = await runAsEntry(definition, () =>
    wraps === undefined
      ? run()
      : runWrapped(
          wraps,
          {
            context,
            functionKey: definition.key,
            input: request,
            kind: "route",
            route: routeName(route),
          },
          run
        )
  );

  return await parseRouteOutput(route, result);
};

// `functions.route(...)`: every failure propagates as an InvokeError with its full issues.
const runRoute = async (
  route: AnyRouteDefinition,
  input: RouteInvocationInput<AnyRouteDefinition>,
  definition?: AnyFunctionDefinition
): Promise<unknown> =>
  await runRouteHandler(
    route,
    await createRouteRequest(route, input),
    definition
  );

const routeRequestErrorResponse = (error: RouteRequestError): Response => {
  if (error.status === 415) {
    return responseError("Unsupported content type: send application/json", {
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
    });
  }

  return responseError(`Invalid ${error.part}`, {
    code: "INVALID_REQUEST",
    issues: error.issues,
    status: 400,
  });
};

// Only a failure while building the Route Request is the client's mistake. Anything the handler
// throws, an InvokeError from a nested call included, is a server failure for `app.onError`.
const routeResponse = async (
  route: AnyRouteDefinition,
  input: RouteInvocationInput<AnyRouteDefinition>,
  definition: AnyFunctionDefinition,
  readText: () => Promise<string>
): Promise<Response> => {
  let request: RouteRequest<unknown, unknown, unknown, unknown>;

  try {
    request = await createRouteRequest(route, input, readText);
  } catch (error) {
    if (error instanceof RouteRequestError) {
      return routeRequestErrorResponse(error);
    }

    throw error;
  }

  const result = await runRouteHandler(route, request, definition);

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

export interface RequestAuthorizerOutcome {
  readonly authorized: boolean;
  /** The validated authorizer context; empty when the request is not authorized. */
  readonly context: Record<string, unknown>;
}

/**
 * Runs a Request Authorizer Function the way every runtime does: an invoke context with its
 * Runtime Variables loaded, a boolean `authorized`, and `context` validated against the Function's
 * `context` schema. Throws InvokeError for an invalid result. Shared by local route auth and the
 * deployed authorizer adapter.
 */
export const runRequestAuthorizer = async (
  definition: RequestAuthorizerFunctionDefinition,
  request: AuthorizerRequest
): Promise<RequestAuthorizerOutcome> => {
  const handler = definition.handler as RequestAuthorizerHandler;
  const runtimeContext = createInvokeContext(
    definition as unknown as AnyFunctionDefinition,
    {}
  );
  await loadRuntimeVariablesBeforeHandler(runtimeContext.variables);
  const wraps = functionWraps(definition);
  const result = (await runAsEntry(
    definition as unknown as BaseFunctionDefinition,
    () =>
      wraps === undefined
        ? handler(request, runtimeContext)
        : runWrapped(
            wraps,
            {
              context: runtimeContext,
              functionKey: definition.key,
              input: request,
              kind: "authorizer",
            },
            () => handler(request, runtimeContext)
          )
  )) as Awaited<ReturnType<RequestAuthorizerHandler>> | undefined;

  if (typeof result?.authorized !== "boolean") {
    throw new InvokeError("Invalid authorizer result", {
      code: "INVALID_RESULT",
    });
  }

  if (!result.authorized) {
    return { authorized: false, context: {} };
  }

  const context =
    definition.context === undefined
      ? (result.context ?? {})
      : await parseWithSchema(
          definition.context as StandardSchemaV1<
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

  return { authorized: true, context };
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

  const hasIdentity = authorizer.identitySource.every((source) => {
    const header = identityHeaderName(source);

    if (header === undefined) {
      return false;
    }

    const value = headers.get(header);

    return value !== null && value.trim() !== "";
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
    const result = await runRequestAuthorizer(
      target as RequestAuthorizerFunctionDefinition,
      { headers, raw: request, request }
    );

    if (!result.authorized) {
      return jsonError("Forbidden", { code: "FORBIDDEN", status: 403 });
    }

    return {
      context: result.context,
      source: "lambda",
    };
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Authorizer failed",
      { code: "INTERNAL_SERVER_ERROR", status: 500 }
    );
  }
};

// A Provider may report that the platform already authorized the request (for example API
// Gateway ran the Lambda authorizer before invoking this Function); then the authorizer does not
// run a second time. Otherwise the route's authorizer is evaluated locally.
const resolveRouteAuth = async (
  route: AnyRouteDefinition,
  definition: AnyFunctionDefinition,
  registry: FunctionRegistry | FunctionRegistryInput,
  context: Context<VokeEnv>,
  provider: VokeProvider | undefined
): Promise<Response | RouteAuthContext | undefined> => {
  if (routeAuthorizerName(route, definition) === undefined) {
    return undefined;
  }

  const platformAuth = provider?.runtime?.routeAuth?.({ env: context.env });

  if (platformAuth !== undefined) {
    return platformAuth;
  }

  return await evaluateLocalAuthorizer(
    route,
    definition,
    registry,
    context.req.raw,
    contextHeaders(context)
  );
};

const mountRoute = (
  app: Hono<VokeEnv>,
  route: AnyRouteDefinition,
  definition: AnyFunctionDefinition,
  registry: FunctionRegistry | FunctionRegistryInput,
  provider: VokeProvider | undefined
): void => {
  app.on([route.method], [route.path], ...route.middleware, async (context) => {
    const auth = await resolveRouteAuth(
      route,
      definition,
      registry,
      context,
      provider
    );

    if (auth instanceof Response) {
      return auth;
    }

    return await routeResponse(
      route,
      {
        auth,
        headers: headerRecord(context.req.raw.headers),
        params: context.req.param(),
        query: queryRecord(context.req.url),
        request: context.req.raw,
      },
      definition,
      // Hono caches a body that route middleware already read through `c.req`.
      async () =>
        context.req.raw.bodyUsed
          ? await context.req.text()
          : await context.req.raw.clone().text()
    );
  });
};

const sleepAndThrow = async (
  timeoutMs: number,
  message: string,
  functionName: string
) => {
  await sleep(timeoutMs);
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
  const context = createInvokeContext(definition, options);
  await loadRuntimeVariablesBeforeHandler(context.variables);
  const wraps = functionWraps(definition);
  const result = await withTimeout(
    runAsEntry(definition, () =>
      wraps === undefined
        ? definition.handler(parsedPayload, context)
        : (runWrapped(
            wraps,
            {
              context,
              functionKey: definition.key,
              input: parsedPayload,
              kind: "invokable",
            },
            () => definition.handler(parsedPayload, context)
          ) as Promise<StandardSchemaInput<TOutputSchema>>)
    ),
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

/**
 * How a transport invocation is addressed. `runtime: "aws"` sends the `{ payload, trace }`
 * envelope to the deployed name and unwraps a `{ data }` result; a Provider-routed Function
 * gets the bare payload at the Provider's target and its result is used as returned.
 */
interface TransportRoute {
  envelope: boolean;
  functionName: string;
  missingTransportMessage: string;
  transport: InvokeTransport | undefined;
}

const invokeThroughTransport = async (
  definition: InvokableFunctionDefinition,
  payload: unknown,
  options: InvokeOptions,
  route: TransportRoute
): Promise<unknown> => {
  const { transport } = route;
  const functionName = deployedName(definition);

  if (transport === undefined) {
    throw new InvokeError(route.missingTransportMessage, {
      code: "MISSING_TRANSPORT",
      functionName,
    });
  }

  const parsedPayload = await parsePayload(definition, payload);
  const response = await runWithRetries(
    () =>
      withTimeout(
        Promise.resolve()
          .then(() =>
            transport.invoke({
              ...(options.executionName === undefined
                ? {}
                : { executionName: options.executionName }),
              functionName: route.functionName,
              invocationType:
                options.mode === "async" ? "Event" : "RequestResponse",
              payload: route.envelope
                ? {
                    payload: parsedPayload,
                    trace: resolveTrace(options),
                  }
                : parsedPayload,
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
      ...(response.executionId === undefined
        ? {}
        : { executionId: response.executionId }),
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

  return await parseResult(
    definition,
    route.envelope ? unwrapPayload(response.payload) : response.payload
  );
};

const invokeAws = async (
  definition: InvokableFunctionDefinition,
  payload: unknown,
  options: InvokeOptions
): Promise<unknown> => {
  const functionName = deployedName(definition);

  return await invokeThroughTransport(definition, payload, options, {
    envelope: true,
    functionName,
    missingTransportMessage: `invoke("${functionName}") requires an InvokeTransport for runtime "aws"`,
    transport: options.transport,
  });
};

/** The Provider's target for this Function, unless the caller chose a runtime explicitly. */
const providerInvokeTarget = (
  definition: InvokableFunctionDefinition,
  options: InvokeOptions
):
  | { capability: ProviderInvokeCapability; target: ProviderInvokeTarget }
  | undefined => {
  if (options.runtime !== undefined) {
    return undefined;
  }

  const capability = activatedFunctionDefinitions.get(definition)?.invoke;
  const target = capability?.target?.({ definition, key: definition.key });

  return capability === undefined || target === undefined
    ? undefined
    : { capability, target };
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
  const routed = providerInvokeTarget(definition, invokeOptions);

  if (routed !== undefined) {
    const functionName = deployedName(definition);

    return await runOutsideEntry(() =>
      invokeThroughTransport(definition, payload, invokeOptions, {
        envelope: false,
        functionName: routed.target.functionName,
        missingTransportMessage: `invoke("${functionName}") is routed by the Provider, which supplies no invoke transport`,
        transport: routed.capability.transport?.(),
      })
    );
  }

  const acceptsExecutionName =
    activatedFunctionDefinitions
      .get(definition)
      ?.invoke?.acceptsExecutionName?.({ definition, key: definition.key }) ===
    true;

  if (options.executionName !== undefined && !acceptsExecutionName) {
    const functionName = deployedName(definition);

    throw new InvokeError(
      `invoke("${functionName}") cannot use executionName: the Provider accepts it only for Functions whose executions it names`,
      { code: "INVALID_OPTIONS", functionName }
    );
  }

  if (resolveRuntime(invokeOptions) === "aws") {
    return await runOutsideEntry(() =>
      invokeAws(definition, payload, invokeOptions)
    );
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

// createFunctions guarantees at least one Event Source, all of one source type.
const eventSourceType = (definition: EventFunctionDefinition): string =>
  definition.events[0]?.source ?? "event";

const sendEventToFunction = async (
  definition: EventFunctionDefinition | undefined,
  event: unknown,
  options: InvokeOptions = {}
): Promise<unknown> => {
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
      new InvokeError(
        `Invalid "${eventSourceType(definition)}" event for ${functionName}: ${message}`,
        { cause, code: "INVALID_PAYLOAD", functionName }
      )
  );

  const context = createInvokeContext(definition, options);
  await loadRuntimeVariablesBeforeHandler(context.variables);
  const wraps = functionWraps(definition);

  return await runAsEntry(definition, () =>
    wraps === undefined
      ? definition.handler(parsedEvent, context)
      : runWrapped(
          wraps,
          {
            context,
            functionKey: definition.key,
            input: parsedEvent,
            kind: "event",
          },
          () => definition.handler(parsedEvent, context)
        )
  );
};

export function fn<
  const TInputSchema extends AnyStandardSchema,
  const TOutputSchema extends AnyStandardSchema,
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: InvokableFunctionWithInputDefinitionInput<
    TInputSchema,
    TOutputSchema,
    TVariables,
    TResources
  >
): InvokableFunctionDefinition<string, TInputSchema, TOutputSchema, TVariables>;
export function fn<
  const TOutputSchema extends AnyStandardSchema,
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: InvokableZeroInputFunctionDefinitionInput<
    TOutputSchema,
    TVariables,
    TResources
  >
): InvokableFunctionDefinition<string, undefined, TOutputSchema, TVariables>;
export function fn<
  const TRoutes extends readonly AnyRouteDefinition[],
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
>(
  definition: RouteFunctionDefinitionInput<TRoutes> & {
    readonly variables?: TVariables;
  }
): RouteFunctionDefinition<string, TRoutes, TVariables>;
export function fn(
  definition:
    | InvokableFunctionWithInputDefinitionInput<
        AnyStandardSchema,
        AnyStandardSchema
      >
    | InvokableZeroInputFunctionDefinitionInput<AnyStandardSchema>
    | RouteFunctionDefinitionInput
): AnyFunctionDefinition {
  if (definition.name !== undefined && definition.name.trim() === "") {
    throw new Error("Function definition name must not be empty");
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

export const http = <
  const TRoutes extends AnyRouteDefinition | readonly AnyRouteDefinition[],
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: HttpFunctionDefinitionInput<TRoutes, TVariables, TResources>
): RouteFunctionDefinition<string, RouteInputList<TRoutes>, TVariables> => {
  const routeInput =
    typeof definition.routes === "function"
      ? definition.routes(new Voke<TVariables, TResources[number]>())
      : definition.routes;
  const routes = (Array.isArray(routeInput)
    ? routeInput
    : [routeInput]) as unknown as RouteInputList<TRoutes>;

  return Object.freeze({
    authorizer: definition.authorizer,
    authorizers: definition.authorizers,
    key: "",
    kind: "route",
    name: definition.name,
    resources: definition.resources,
    routes: Object.freeze([...routes]) as unknown as RouteInputList<TRoutes>,
    synthesis: definition.synthesis,
    variables: definition.variables,
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
  registry: FunctionRegistry | FunctionRegistryInput,
  provider?: VokeProvider
): void => {
  for (const [, definition] of functionRegistryEntries(registry)) {
    if (definition.routes === undefined || definition.routes.length === 0) {
      continue;
    }

    for (const route of definition.routes) {
      mountRoute(app, route, definition, registry, provider);
    }
  }
};

export const assertUniqueFunctionRoutes = (
  registry: FunctionRegistry | FunctionRegistryInput
): void => {
  const routes = new Map<string, string>();

  for (const [key, definition] of functionRegistryEntries(registry)) {
    if (definition.routes === undefined || definition.routes.length === 0) {
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

export const assertRouteParamSchemas = (
  registry: FunctionRegistry | FunctionRegistryInput
): void => {
  for (const [, definition] of functionRegistryEntries(registry)) {
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

// Header names arrive lower-case, so a schema that names a header in another case never matches.
export const assertRouteHeaderSchemas = (
  registry: FunctionRegistry | FunctionRegistryInput
): void => {
  for (const [, definition] of functionRegistryEntries(registry)) {
    for (const route of definition.routes ?? []) {
      const invalid = (schemaObjectKeys(route.headers) ?? []).filter(
        (key) => key !== key.toLowerCase()
      );

      if (invalid.length > 0) {
        throw new VokeConfigError(
          `Route ${route.method} ${route.path} headers schema names ${invalid.map((key) => JSON.stringify(key)).join(", ")}; header names are lower-case, so write ${invalid.map((key) => JSON.stringify(key.toLowerCase())).join(", ")}`
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
    colorize(eventSource.resource ?? "-", color.bold),
    colorize(
      Object.entries(eventSource.properties)
        // Scalars print as-is; objects and arrays (an event pattern, a filter policy) as JSON.
        .map(
          ([name, value]) =>
            `${name}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`
        )
        .join(" "),
      color.dim
    ),
  ].join(" ");

const routeUrl = (path: string): string | undefined => {
  const origin = readEnv("VOKE_DEV_ORIGIN");

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
  (readEnv("VOKE_DEV_ORIGIN") ?? "http://localhost:3000").replace(/[/]+$/u, "");

const devReadyMs = (): number => {
  const startedAt = Number(readEnv("VOKE_DEV_STARTED_AT"));

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

  for (const [key, definition] of functionRegistryEntries(registry)) {
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

// Provider packages build Event Source Functions directly, so every rule that keeps their
// Function Contract unambiguous is checked here, where every definition passes.
const assertEventFunctionShape = (
  key: string,
  definition: AnyFunctionDefinition
): void => {
  if (definition.kind !== "event") {
    return;
  }

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

  const [first, ...rest] = definition.events ?? [];

  if (first === undefined) {
    throw new VokeConfigError(
      `Function "${key}" is an Event Source Function without an Event Source.`
    );
  }

  const other = rest.find((event) => event.source !== first.source);

  if (other !== undefined) {
    throw new VokeConfigError(
      `Function "${key}" mixes Event Sources "${first.source}" and "${other.source}"; a Function's Event Sources must share one source.`
    );
  }
};

export const createFunctions = <const TRegistry extends FunctionRegistryInput>(
  registry: TRegistry
): FunctionRegistry<TRegistry> => {
  const functions = {} as Record<string, AnyFunctionDefinition>;

  for (const [key, definition] of Object.entries(registry)) {
    if (reservedFunctionRegistryKeys.has(key)) {
      throw new VokeConfigError(`Function Registry key "${key}" is reserved`);
    }

    assertEventFunctionShape(key, definition);

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
    value: ((functionName: string, event: unknown) => {
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
      const definition = Object.values(functions).find((candidate) =>
        candidate.routes?.includes(route as AnyRouteDefinition)
      );

      if (route === undefined) {
        throw new InvokeError(`Route not found: ${method} ${path}`, {
          code: "MISSING_FUNCTION",
          functionName: `${method} ${path}`,
        });
      }

      return runRoute(
        route,
        (request ?? {}) as RouteInvocationInput<AnyRouteDefinition>,
        definition
      );
    }) as FunctionRegistryRoute<FunctionRegistry<TRegistry>>,
  });

  return Object.freeze(functions) as FunctionRegistry<TRegistry>;
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
