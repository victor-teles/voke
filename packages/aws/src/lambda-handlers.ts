import {
  activateFunctionRegistry,
  createHandlerExportName,
  defineConfig,
  functionRegistryEntries,
  projectFunctionEntries,
  runRequestAuthorizer,
  voke,
  VokeConfigError,
} from "voke";
import type {
  AnyFunctionDefinition,
  FunctionRegistry,
  RequestAuthorizerFunctionDefinition,
  VokeConfig,
  VokeConfigInput,
  VokePlugin,
} from "voke";

import { createDurableLambdaHandler, isDurableFunction } from "./durable";
import { requireAwsEventSourceRuntimeAdapter } from "./event-source-runtime";
import { createAwsLambdaHandler } from "./lambda";
import type {
  AwsLambdaContext,
  AwsLambdaHttpApiV2Event,
  HonoLikeApp,
} from "./lambda";
import { createAwsInvokeCapability } from "./lambda-invoke-transport";
import { createAwsRuntimeVariableProvider } from "./runtime-variables";

/** The module namespace of a project entrypoint. */
export interface LambdaProjectModule {
  /** A Gateway from `voke(functions, { config })`. */
  default?: unknown;
  /** A Function Registry from `createFunctions({ ... })`. */
  functions?: unknown;
}

export interface LambdaHandlersOptions {
  /**
   * The project config, as `voke build` imports it from `voke.config.ts`. A Function Registry
   * export is then composed into a Gateway with it, so its Plugins apply; a Gateway export must
   * have been created with the same Plugins.
   */
  config?: VokeConfig | VokeConfigInput;
}

export type LambdaHandler = (
  event: unknown,
  context?: unknown
) => Promise<unknown>;

/** The API Gateway HTTP API Lambda authorizer event, payload format 2.0. */
interface HttpApiAuthorizerEvent {
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  rawPath?: string;
  rawQueryString?: string;
  requestContext?: {
    domainName?: string;
    http?: { method?: string };
  };
}

interface GatewayLike {
  app: HonoLikeApp;
  config: { readonly plugins?: readonly VokePlugin[] };
  functions: FunctionRegistry;
}

interface ResolvedProject {
  /** Every Function to export a handler for: the project's, then the Plugin-contributed ones. */
  entries: [string, AnyFunctionDefinition][];
  functions: FunctionRegistry;
  http?: LambdaHandler;
}

const missingExportMessage =
  "The project entrypoint must export a Gateway (export default voke(functions, { config })) or a Function Registry (export const functions = createFunctions({ ... })).";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGateway = (value: unknown): value is GatewayLike =>
  isObject(value) &&
  "app" in value &&
  "config" in value &&
  isObject(value.functions);

const isHttpApiEvent = (event: unknown): event is AwsLambdaHttpApiV2Event =>
  isObject(event) &&
  event.version === "2.0" &&
  isObject(event.requestContext) &&
  isObject(event.requestContext.http);

const authorizerRequest = (event: HttpApiAuthorizerEvent): Request => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.set("cookie", event.cookies.join("; "));
  }

  const host =
    event.requestContext?.domainName ?? headers.get("host") ?? "localhost";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";

  return new Request(`https://${host}${event.rawPath ?? "/"}${query}`, {
    headers,
    method: event.requestContext?.http?.method ?? "GET",
  });
};

const createAuthorizerHandler =
  (
    key: string,
    definition: RequestAuthorizerFunctionDefinition
  ): LambdaHandler =>
  async (event) => {
    try {
      const request = authorizerRequest(event as HttpApiAuthorizerEvent);
      const result = await runRequestAuthorizer(definition, {
        headers: request.headers,
        raw: request,
        request,
      });

      return result.authorized
        ? { context: result.context, isAuthorized: true }
        : { isAuthorized: false };
    } catch (error) {
      // Deny without echoing the reason to the caller; the log keeps it for the operator.
      console.error(`Request Authorizer Function "${key}" failed`, error);

      return { isAuthorized: false };
    }
  };

const pluginNames = (config: {
  readonly plugins?: readonly VokePlugin[];
}): string => JSON.stringify((config.plugins ?? []).map(({ name }) => name));

const resolveGateway = (gateway: GatewayLike): ResolvedProject => {
  const handle = createAwsLambdaHandler(gateway.app);

  return {
    entries: projectFunctionEntries(gateway.functions, gateway.config),
    functions: gateway.functions,
    http: async (event, context) =>
      await handle(
        event as AwsLambdaHttpApiV2Event,
        context as AwsLambdaContext
      ),
  };
};

const resolveProject = (
  project: LambdaProjectModule,
  options: LambdaHandlersOptions
): ResolvedProject => {
  if (isGateway(project.default)) {
    if (
      options.config !== undefined &&
      pluginNames(project.default.config) !==
        pluginNames(defineConfig(options.config))
    ) {
      throw new VokeConfigError(
        "The Gateway was created with a different config than voke.config.ts; pass it: voke(functions, { config })"
      );
    }

    return resolveGateway(project.default);
  }

  if (
    isObject(project.functions) &&
    functionRegistryEntries(project.functions).length > 0
  ) {
    const functions = project.functions as FunctionRegistry;

    if (options.config !== undefined) {
      // One path for Plugins, Runtime Variable providers and every other config-driven behaviour.
      return resolveGateway(voke(functions, { config: options.config }));
    }

    // A registry without a Gateway is activated here so Runtime Variables load from AWS.
    activateFunctionRegistry(functions, "aws-lambda-handlers", {
      invoke: createAwsInvokeCapability(),
      variableProviders: [createAwsRuntimeVariableProvider()],
    });

    return { entries: functionRegistryEntries(functions), functions };
  }

  throw new VokeConfigError(missingExportMessage);
};

const createInvokableHandler =
  (
    key: string,
    definition: AnyFunctionDefinition,
    functions: FunctionRegistry,
    http: LambdaHandler | undefined
  ): LambdaHandler =>
  async (event, context) => {
    const hasRoutes = (definition.routes?.length ?? 0) > 0;

    if (hasRoutes && http !== undefined && isHttpApiEvent(event)) {
      return await http(event, context);
    }

    // The Lambda event is the Function's payload. InvokeError propagates so Lambda reports a
    // function error to the caller.
    return await functions.invoke(
      key as never,
      event as never,
      { runtime: "local" } as never
    );
  };

const handlerFor = (
  key: string,
  definition: AnyFunctionDefinition,
  functions: FunctionRegistry,
  http: LambdaHandler | undefined
): LambdaHandler => {
  switch (definition.kind) {
    case "route": {
      if (http === undefined) {
        throw new VokeConfigError(
          `Function "${key}" serves HTTP routes, so the project entrypoint must export a Gateway: export default voke(functions, { config }).`
        );
      }

      return http;
    }
    case "event": {
      // createFunctions guarantees every Event Source of a Function shares one source.
      const adapter = requireAwsEventSourceRuntimeAdapter(
        definition.events?.[0]?.source ?? "",
        key
      );

      return async (event) =>
        adapter.toResponse(
          await functions.sendEvent(
            key as never,
            adapter.toInvocation(event) as never
          )
        );
    }
    case "authorizer": {
      return createAuthorizerHandler(
        key,
        definition as unknown as RequestAuthorizerFunctionDefinition
      );
    }
    default: {
      if (isDurableFunction(definition)) {
        // The Lambda event is the Function's payload, as for any invokable Function; the call
        // runs inside the durable execution, so contract validation (and anything that wraps
        // functions.invoke) runs on every replay.
        return createDurableLambdaHandler(
          definition,
          async (event) =>
            await functions.invoke(
              key as never,
              event as never,
              { runtime: "local" } as never
            )
        );
      }

      return createInvokableHandler(key, definition, functions, http);
    }
  }
};

/**
 * One AWS Lambda handler per Function declared in the project entrypoint, keyed by the generated
 * handler export name (`createHandlerExportName`). `voke build` generates the entry module that
 * calls this; the deployed handler string is `index.<exportName>`.
 */
export const createLambdaHandlers = (
  project: LambdaProjectModule,
  options: LambdaHandlersOptions = {}
): Record<string, LambdaHandler> => {
  const { entries, functions, http } = resolveProject(project, options);

  return Object.fromEntries(
    entries.map(([key, definition]) => [
      createHandlerExportName(key),
      handlerFor(key, definition, functions, http),
    ])
  );
};
