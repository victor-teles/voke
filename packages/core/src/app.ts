import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import { defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput } from "./config";
import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import { jsonError } from "./http";
import {
  activateFunctionRegistry,
  assertUniqueFunctionRoutes,
  formatDevFunctionSummary,
  InvokeError,
  mountFunctionRoutes,
} from "./invoke";
import type { FunctionRegistry, FunctionRegistryInput } from "./invoke";
import { mountDevFunctionEndpoints } from "./remote";

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

const publicRouteErrorMessage = (error: InvokeError): string => {
  const match = /^Invalid (body|headers|params|query|result) for /u.exec(
    error.message
  );

  if (match === null || error.functionName === undefined) {
    return error.message || "Internal server error";
  }

  return `Invalid ${match[1]} for ${error.functionName}`;
};

const handleRouteError = (error: Error): Response => {
  if (error instanceof InvokeError && error.code === "INVALID_PAYLOAD") {
    return jsonError(publicRouteErrorMessage(error), {
      code: "BAD_REQUEST",
      status: 400,
    });
  }

  return jsonError(
    error instanceof InvokeError
      ? publicRouteErrorMessage(error)
      : error.message || "Internal server error",
    {
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
    }
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
    assertUniqueFunctionRoutes(configInput.functions);
    activateFunctionRegistry(configInput.functions);
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

export const routeModule = <TEnv extends VokeEnv>(
  routes: Hono<TEnv>,
  options: { basePath?: string } = {}
): ApiRouteModule<TEnv> => ({
  basePath: options.basePath,
  routes,
});
