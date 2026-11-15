import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import { defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput, VokeCorsConfig } from "./config";
import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import { jsonError } from "./http";
import {
  activateFunctionRegistry,
  assertRouteParamSchemas,
  assertUniqueFunctionRoutes,
  formatDevFunctionSummary,
  functionRegistryEntries,
  InvokeError,
  mountFunctionRoutes,
} from "./invoke";
import type {
  AnyFunctionDefinition,
  FunctionRegistry,
  FunctionRegistryInput,
  PluginFunctionWrap,
} from "./invoke";
import { projectFunctionEntries } from "./plugin";
import type { PluginRuntimeHooks } from "./plugin";
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

// Logs one JSON line so the error is findable in production logs without reaching the client.
const logUnhandledRouteError = (error: Error): void => {
  const { code } = error as { code?: unknown };

  console.error(
    JSON.stringify({
      ...(typeof code === "string" ? { code } : {}),
      level: "error",
      message: error.message,
      name: error.name,
      stack: error.stack,
    })
  );
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

  logUnhandledRouteError(error);

  // Only `voke dev` sets VOKE_DEV_SUMMARY. The stage is no signal: it defaults to "local" and
  // deployed Functions do not set it, so keying on it would leak messages in production.
  const isDev = readEnv("VOKE_DEV_SUMMARY") === "1";

  return responseError("Internal server error", {
    code: "INTERNAL_SERVER_ERROR",
    ...(isDev ? { details: { message: error.message } } : {}),
    status: 500,
  });
};

// The same normalized `api.cors` drives the deployed API's CORS configuration, so a preflight
// through the local Gateway answers like the deployed one.
const corsMiddleware = (config: VokeCorsConfig): MiddlewareHandler<VokeEnv> =>
  cors({
    allowHeaders: config.headers,
    allowMethods: config.methods,
    credentials: config.credentials,
    ...(config.maxAgeSeconds === undefined
      ? {}
      : { maxAge: config.maxAgeSeconds }),
    origin: config.origins.includes("*") ? "*" : config.origins,
  });

// The configured Provider supplies its Runtime Variable providers (for example the AWS
// Secrets Manager/SSM loader); explicit providers are added after them.
const gatewayVariableProviders = (
  config: VokeConfig,
  variables: GatewayVariableOptions | undefined
): RuntimeVariableProvider[] => [
  ...(config.provider?.runtime?.variables?.() ?? []),
  ...(variables?.providers ?? []),
];

interface PluginSetup {
  hooks: PluginRuntimeHooks;
  plugin: string;
}

// Each Plugin's `runtime.setup` runs once per Gateway, with every Function the Gateway serves.
const setupPlugins = (
  config: VokeConfig,
  functions: readonly (readonly [string, AnyFunctionDefinition])[]
): PluginSetup[] => {
  const dev = readEnv("VOKE_DEV_SUMMARY") === "1";
  const setups: PluginSetup[] = [];

  for (const plugin of config.plugins) {
    const hooks = plugin.runtime?.setup({ config, dev, functions });

    if (hooks !== undefined) {
      setups.push({ hooks, plugin: plugin.name });
    }
  }

  return setups;
};

const pluginWraps = (setups: readonly PluginSetup[]): PluginFunctionWrap[] =>
  setups.flatMap(({ hooks, plugin }) =>
    hooks.wrap === undefined ? [] : [{ plugin, wrap: hooks.wrap }]
  );

const createGatewayApp = (
  config: VokeConfig,
  functions: FunctionRegistry | FunctionRegistryInput,
  options: VokeOptions
): Hono<VokeEnv> => {
  const app = new Hono<VokeEnv>();
  // The project's Functions, then the Plugin-contributed ones; `functions` itself is not changed.
  const entries = projectFunctionEntries(functions, config);
  const gatewayFunctions: FunctionRegistryInput = Object.fromEntries(entries);
  const plugins = setupPlugins(config, entries);

  app.use("*", async (c, next) => {
    const env = (c.env ??= {});
    env.VOKE_CONFIG = config;
    await next();
  });

  if (config.api.cors !== undefined) {
    app.use("*", corsMiddleware(config.api.cors));
  }

  for (const { hooks } of plugins) {
    for (const middleware of hooks.middleware ?? []) {
      app.use("*", middleware);
    }
  }

  for (const middleware of options.middleware ?? []) {
    app.use("*", middleware);
  }

  app.notFound(() =>
    jsonError("Route not found", { code: "NOT_FOUND", status: 404 })
  );
  app.onError(handleRouteError);

  assertUniqueFunctionRoutes(gatewayFunctions);
  assertRouteParamSchemas(gatewayFunctions);
  const activation = {
    invoke: config.provider?.invoke,
    variableOverrides: options.variables?.overrides,
    variableProviders: gatewayVariableProviders(config, options.variables),
    wraps: pluginWraps(plugins),
  };
  activateFunctionRegistry(functions, activationKey(config), activation);

  const pluginFunctions = entries.slice(
    functionRegistryEntries(functions).length
  );

  if (pluginFunctions.length > 0) {
    // Plugin Functions are activated like the project's, from a record of their own.
    activateFunctionRegistry(
      Object.fromEntries(pluginFunctions),
      activationKey(config),
      activation
    );
  }

  mountFunctionRoutes(app, gatewayFunctions, config.provider);

  if (readEnv("VOKE_DEV_SUMMARY") === "1") {
    mountDevFunctionEndpoints(app, { functions, project: config.name });
    console.info(formatDevFunctionSummary(gatewayFunctions));
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
