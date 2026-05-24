import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import { createAwsLambdaHandler } from "./aws-lambda";
import type {
  AwsLambdaContext,
  AwsLambdaHttpApiV2Event,
  AwsLambdaHttpApiV2Result,
} from "./aws-lambda";
import { defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput } from "./config";
import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import { jsonError } from "./http";
import {
  activateFunctionRegistry,
  assertRouteParamSchemas,
  assertUniqueFunctionRoutes,
  formatDevFunctionSummary,
  InvokeError,
  mountFunctionRoutes,
} from "./invoke";
import type { FunctionRegistry, FunctionRegistryInput } from "./invoke";
import { mountDevFunctionEndpoints } from "./remote";
import { error as responseError } from "./response";

export interface ApiRouteModule<TEnv extends VokeEnv = VokeEnv> {
  basePath?: string;
  routes: Hono<TEnv>;
}

export interface ApiAppOptions {
  config: VokeConfigInput;
  middleware?: MiddlewareHandler<VokeEnv>[];
  routes?: ApiRouteModule[];
}

export interface GatewayOptions {
  config?: VokeConfigInput;
  functions?: FunctionRegistry | FunctionRegistryInput;
  middleware?: MiddlewareHandler<VokeEnv>[];
  routes?: ApiRouteModule[];
}

export interface VokeOptions {
  config?: VokeConfigInput;
  middleware?: MiddlewareHandler<VokeEnv>[];
}

export type Middleware = MiddlewareHandler<VokeEnv>;

export interface GatewayRuntime<TFunctions extends FunctionRegistry> {
  app: Hono<VokeEnv>;
  config: VokeConfig;
  fetch: Hono<VokeEnv>["fetch"];
  functions: TFunctions;
  handler: (
    event: AwsLambdaHttpApiV2Event,
    context?: AwsLambdaContext
  ) => Promise<AwsLambdaHttpApiV2Result>;
  name: string;
  request: Hono<VokeEnv>["request"];
}

const activationKey = (config: VokeConfig): string =>
  JSON.stringify({
    name: config.name,
    region: config.region,
    stage: config.stage,
  });

const publicRouteErrorMessage = (error: InvokeError): string => {
  const match = /^Invalid (body|headers|params|query|result) for /u.exec(
    error.message
  );

  if (match === null || error.functionName === undefined) {
    return error.message || "Internal server error";
  }

  return `Invalid ${match[1]} for ${error.functionName}`;
};

const publicRouteErrorTitle = (error: InvokeError): string => {
  if (error.message.startsWith("Invalid body for ")) {
    return "Invalid body";
  }

  if (error.message.startsWith("Invalid headers for ")) {
    return "Invalid headers";
  }

  if (error.message.startsWith("Invalid params for ")) {
    return "Invalid params";
  }

  if (error.message.startsWith("Invalid query for ")) {
    return "Invalid query";
  }

  if (error.message.startsWith("Invalid result for ")) {
    return "Invalid result";
  }

  return publicRouteErrorMessage(error);
};

const handleRouteError = (error: Error): Response => {
  if (error instanceof InvokeError && error.code === "INVALID_PAYLOAD") {
    return responseError(publicRouteErrorTitle(error), {
      issues: error.issues,
      status: 400,
    });
  }

  if (error instanceof InvokeError && error.code === "INVALID_RESULT") {
    return responseError(publicRouteErrorTitle(error), {
      issues: error.issues,
      status: 500,
    });
  }

  return responseError(
    error instanceof InvokeError
      ? publicRouteErrorMessage(error)
      : error.message || "Internal server error",
    { status: 500 }
  );
};

const apiAppConfig = new WeakMap<object, VokeConfig>();

export const getApiAppConfig = (app: object): VokeConfig | undefined =>
  apiAppConfig.get(app);

export const createApiApp = (options: ApiAppOptions): Hono<VokeEnv> => {
  const app = new Hono<VokeEnv>();
  const config = defineConfig(options.config);

  apiAppConfig.set(app, config);

  app.use("*", async (c, next) => {
    const env = (c.env ??= {});
    env.VOKE_CONFIG = config;
    await next();
  });

  for (const middleware of options.middleware ?? []) {
    app.use("*", middleware);
  }

  app.notFound(() =>
    jsonError("Route not found", { code: "NOT_FOUND", status: 404 })
  );

  app.onError(handleRouteError);

  for (const route of options.routes ?? []) {
    app.route(route.basePath ?? "/", route.routes);
  }

  return app;
};

export const createGateway = (options: GatewayOptions = {}): Hono<VokeEnv> => {
  if (
    options.functions !== undefined &&
    options.config?.functions !== undefined
  ) {
    throw new VokeConfigError(
      "Pass functions either top-level or in config.functions, not both"
    );
  }

  const configInput = {
    ...options.config,
    functions: options.functions ?? options.config?.functions,
    name: options.config?.name ?? "api",
  };
  const gateway = createApiApp({
    config: configInput,
    middleware: options.middleware,
    routes: options.routes,
  });

  if (configInput.functions !== undefined) {
    const config = getApiAppConfig(gateway);

    assertUniqueFunctionRoutes(configInput.functions);
    assertRouteParamSchemas(configInput.functions);
    activateFunctionRegistry(
      configInput.functions,
      activationKey(config ?? defineConfig(configInput))
    );
    mountFunctionRoutes(gateway, configInput.functions);

    if (Bun.env.VOKE_DEV_SUMMARY === "1") {
      mountDevFunctionEndpoints(gateway, {
        functions: configInput.functions,
        project: configInput.name,
      });
      console.info(formatDevFunctionSummary(configInput.functions));
    }
  }

  return gateway;
};

const loadRuntimeConfig = (): VokeConfigInput => {
  const cwd = Bun.env.PWD ?? ".";
  const path = `${cwd}/voke.config.ts`;

  try {
    // oxlint-disable-next-line unicorn/prefer-module, node/global-require -- voke(functions) composes synchronously, so source config loading needs Bun's sync require path.
    const module = require(path) as { config?: unknown; default?: unknown };
    const config = module.default ?? module.config;

    if (config === undefined) {
      throw new VokeConfigError(
        `Voke config must export a default config from ${path}`
      );
    }

    return config as VokeConfigInput;
  } catch (error) {
    if (error instanceof VokeConfigError) {
      throw error;
    }

    throw new VokeConfigError(`Voke config file not found: ${path}`, {
      cause: error,
    });
  }
};

export const voke = <const TFunctions extends FunctionRegistry>(
  functions: TFunctions,
  options: VokeOptions = {}
): GatewayRuntime<TFunctions> => {
  const configInput = options.config ?? loadRuntimeConfig();
  const { functions: _configuredFunctions, ...gatewayConfig } = configInput;
  const app = createGateway({
    config: gatewayConfig,
    functions,
    middleware: options.middleware,
  });
  const config = defineConfig({ ...configInput, functions });
  const handler = createAwsLambdaHandler(app);

  return {
    app,
    config,
    fetch: app.fetch.bind(app) as Hono<VokeEnv>["fetch"],
    functions,
    handler: (event, context) => handler(event, context as AwsLambdaContext),
    name: config.name,
    request: app.request.bind(app) as Hono<VokeEnv>["request"],
  };
};

export const routeModule = <TEnv extends VokeEnv>(
  routes: Hono<TEnv>,
  options: { basePath?: string } = {}
): ApiRouteModule<TEnv> => ({
  basePath: options.basePath,
  routes,
});
