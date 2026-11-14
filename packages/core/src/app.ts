import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

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
import { readEnv } from "./runtime-env";
import type {
  RuntimeVariableOverrides,
  RuntimeVariableProvider,
} from "./variables";

export interface GatewayVariableOptions {
  overrides?: RuntimeVariableOverrides;
  providers?: readonly RuntimeVariableProvider[];
}

export interface VokeOptions {
  /** Project config. The Provider is set here (`provider: aws()`), never on `voke()`. */
  config?: VokeConfigInput;
  middleware?: MiddlewareHandler<VokeEnv>[];
  variables?: GatewayVariableOptions;
}

export type Middleware = MiddlewareHandler<VokeEnv>;

export interface GatewayRuntime<TFunctions extends FunctionRegistry> {
  app: Hono<VokeEnv>;
  config: VokeConfig;
  fetch: Hono<VokeEnv>["fetch"];
  functions: TFunctions;
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

// The configured Provider supplies its Runtime Variable providers (for example the AWS
// Secrets Manager/SSM loader); explicit providers are added after them.
const gatewayVariableProviders = (
  config: VokeConfig,
  variables: GatewayVariableOptions | undefined
): RuntimeVariableProvider[] => [
  ...(config.provider?.runtime?.variables?.() ?? []),
  ...(variables?.providers ?? []),
];

const createGatewayApp = (
  config: VokeConfig,
  functions: FunctionRegistry | FunctionRegistryInput,
  options: VokeOptions
): Hono<VokeEnv> => {
  const app = new Hono<VokeEnv>();

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

  assertUniqueFunctionRoutes(functions);
  assertRouteParamSchemas(functions);
  activateFunctionRegistry(functions, activationKey(config), {
    variableOverrides: options.variables?.overrides,
    variableProviders: gatewayVariableProviders(config, options.variables),
  });
  mountFunctionRoutes(app, functions, config.provider);

  if (readEnv("VOKE_DEV_SUMMARY") === "1") {
    mountDevFunctionEndpoints(app, { functions, project: config.name });
    console.info(formatDevFunctionSummary(functions));
  }

  return app;
};

const loadRuntimeConfig = (): VokeConfigInput => {
  const cwd = readEnv("PWD") ?? ".";
  const path = `${cwd}/voke.config.ts`;

  try {
    // oxlint-disable-next-line unicorn/prefer-module, node/global-require -- voke(functions) composes synchronously, so source config loading needs Bun's sync require path.
    const module = require(path) as { default?: unknown };
    const config = module.default;

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

    throw new VokeConfigError(
      `Voke config file not found: ${path}. In a deployed bundle voke.config.ts is not on disk; pass it explicitly: voke(functions, { config }).`,
      { cause: error }
    );
  }
};

export const voke = <const TFunctions extends FunctionRegistry>(
  functions: TFunctions,
  options: VokeOptions = {}
): GatewayRuntime<TFunctions> => {
  const config = defineConfig(options.config ?? loadRuntimeConfig());
  const app = createGatewayApp(config, functions, options);

  return {
    app,
    config,
    fetch: app.fetch.bind(app) as Hono<VokeEnv>["fetch"],
    functions,
    name: config.name,
    request: app.request.bind(app) as Hono<VokeEnv>["request"],
  };
};
