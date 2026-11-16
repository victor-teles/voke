import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Context } from "hono";

import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import type { VokeIssue } from "./errors";
import type {
  VokeModelProviderExtensionRecord,
  VokeModelRecord,
} from "./model";
import { isNonNegativeInteger, positiveIntegerIssue } from "./numbers";
import { definePlugins, mergePluginContributions } from "./plugin";
import type { VokePlugin } from "./plugin";
import type { VokeProvider } from "./provider";
import { defineRemoteConfig } from "./remote";
import type { VokeRemoteConfig, VokeRemoteConfigInput } from "./remote";
import { readEnv } from "./runtime-env";

export interface VokeConfig {
  api: VokeApiConfig;
  name: string;
  stage: string;
  region: string;
  entrypoint: string;
  build: VokeBuildConfig;
  cloudFormation: VokeCloudFormationConfig;
  dev: VokeDevConfig;
  /** Environment variables set on every deployed Function. */
  environment: Record<string, string>;
  /** Plugins in declaration order; the first one is the outermost Function Wrap. Empty when none. */
  plugins: VokePlugin[];
  provider?: VokeProvider;
  remotes?: Record<string, VokeRemoteConfig>;
  /** Infrastructure resources (queues, tables, buckets, ...) the project declares. */
  resources: Record<string, VokeResourceInput>;
  runtime: VokeRuntimeConfig;
}

export interface VokeApiConfig {
  /** Cross-origin access for browsers, applied to the local Gateway and the deployed API alike. Off when absent. */
  cors?: VokeCorsConfig;
  name: string;
}

export interface VokeCorsConfig {
  credentials: boolean;
  headers: string[];
  maxAgeSeconds?: number;
  methods: string[];
  origins: string[];
}

export interface VokeApiConfigInput {
  /** `true` allows any origin, method and header without credentials. */
  cors?: boolean | Partial<VokeCorsConfig>;
  name?: string;
}

export interface VokeBuildConfig {
  entrypoints: string[];
  /** Module patterns left out of the bundle. Defaults to the AWS SDK, which the Lambda Node.js runtime provides. */
  external: string[];
  outdir: string;
}

export interface VokeCloudFormationConfig {
  /** Where `voke synth` writes the template. */
  out: string;
}

export interface VokeResourceInput {
  actions: string[];
  bindingAttribute: string;
  bindingValue: "ref" | "getAttArn" | "getAttId";
  cloudFormationType: string;
  outputName: string;
  policyResource:
    | "ref"
    | "getAttArn"
    | "getAttId"
    | "parameterArn"
    | "s3ArnWithObjects";
  provider?: Record<string, VokeModelProviderExtensionRecord>;
  properties: VokeModelRecord;
}

export interface VokeDevConfig {
  entrypoint: string;
  environment: Record<string, string>;
}

export interface VokeRuntimeConfig {
  /** Memory for every Function, in MB. Default 1024. */
  memory: number;
  /** Maximum run time for every Function, in seconds. Default 15. */
  timeout: number;
}

export interface VokeConfigInput {
  name: string;
  api?: VokeApiConfigInput;
  stage?: string;
  region?: string;
  entrypoint?: string;
  build?: Partial<VokeBuildConfig>;
  cloudFormation?: Partial<VokeCloudFormationConfig>;
  dev?: Partial<VokeDevConfig>;
  /** Plugins that extend the project at run time and deploy time. */
  plugins?: readonly VokePlugin[];
  provider?: VokeProvider;
  remotes?: Record<string, VokeRemoteConfig | VokeRemoteConfigInput>;
  runtime?: Partial<VokeRuntimeConfig>;
  environment?: Record<string, string>;
  resources?: Record<string, VokeResourceInput>;
}

const wildcard = ["*"];

const defineCorsConfig = (
  input: VokeApiConfigInput["cors"]
): VokeCorsConfig | undefined => {
  if (input === undefined || input === false) {
    return undefined;
  }

  const cors: VokeCorsConfig = {
    credentials: false,
    headers: wildcard,
    methods: wildcard,
    origins: wildcard,
    ...(input === true ? {} : input),
  };
  const issues: VokeIssue[] = [];

  if (cors.origins.length === 0) {
    issues.push({
      message: "expected at least one origin; received []",
      path: "api.cors.origins",
    });
  }

  if (cors.credentials && cors.origins.includes("*")) {
    issues.push({
      message: `expected explicit origins when credentials is true; received ${JSON.stringify(cors.origins)}. List explicit origins: api.cors.origins`,
      path: "api.cors.credentials",
    });
  }

  if (
    cors.maxAgeSeconds !== undefined &&
    !isNonNegativeInteger(cors.maxAgeSeconds)
  ) {
    issues.push({
      message: `expected a non-negative integer number of seconds; received ${JSON.stringify(cors.maxAgeSeconds)}`,
      path: "api.cors.maxAgeSeconds",
    });
  }

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return {
    credentials: cors.credentials,
    headers: [...cors.headers],
    ...(cors.maxAgeSeconds === undefined
      ? {}
      : { maxAgeSeconds: cors.maxAgeSeconds }),
    methods: [...cors.methods],
    origins: [...cors.origins],
  };
};

const defineApiConfig = (input: VokeConfigInput): VokeApiConfig => {
  const cors = defineCorsConfig(input.api?.cors);

  return {
    ...(cors === undefined ? {} : { cors }),
    name: input.api?.name ?? input.name,
  };
};

export const createHandlerNameFromEntrypoint = (entrypoint: string): string => {
  const moduleName = basename(entrypoint).replace(/\.[^.]+$/u, "");

  return `${moduleName}.handler`;
};

const unique = (values: string[]): string[] => [...new Set(values)];

const defaultBuildExternal = ["@aws-sdk/*"];

const functionsInEntrypointMessage =
  "Functions are declared in the project entrypoint, not in voke.config.ts. Export them from the entrypoint: export default voke(functions, { config }) or export const functions = createFunctions({ ... })";
const generatedHandlerMessage =
  "was removed; Voke generates one Lambda handler per Function from the project entrypoint";

// Settings removed by ADR 0007 (opinionated framework). They fail loudly instead of being ignored,
// because a silently ignored setting would change what gets deployed.
const removedSettings = (
  input: VokeConfigInput
): { message: string; path: string }[] => {
  const raw = input as unknown as Record<string, unknown> & {
    api?: Record<string, unknown>;
    build?: Record<string, unknown>;
    cloudFormation?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
  };
  const issues: { message: string; path: string }[] = [];

  if ("functions" in raw) {
    issues.push({ message: functionsInEntrypointMessage, path: "functions" });
  }

  if ("handler" in raw) {
    issues.push({
      message: `"handler" ${generatedHandlerMessage}`,
      path: "handler",
    });
  }

  for (const key of ["resources", "environment"]) {
    if (raw.cloudFormation !== undefined && key in raw.cloudFormation) {
      issues.push({
        message: `"cloudFormation.${key}" was removed; declare ${key} at the top level: ${key}: { ... }`,
        path: `cloudFormation.${key}`,
      });
    }
  }

  if (raw.cloudFormation !== undefined && "handler" in raw.cloudFormation) {
    issues.push({
      message: `"cloudFormation.handler" ${generatedHandlerMessage}`,
      path: "cloudFormation.handler",
    });
  }

  for (const key of ["function", "routes", "protocol"]) {
    if (raw.api !== undefined && key in raw.api) {
      issues.push({
        message: `"api.${key}" was removed; HTTP routes come from the route-backed Functions in the project entrypoint`,
        path: `api.${key}`,
      });
    }
  }

  if ("local" in raw) {
    issues.push({
      message:
        'local AWS settings moved to the provider: aws({ local: floci() }) from "@voke/aws" and "@voke/aws/local"',
      path: "local",
    });
  }

  if (raw.runtime !== undefined && "lambda" in raw.runtime) {
    issues.push({
      message:
        '"runtime.lambda" moved to the AWS provider; use aws({ lambda: { runtime } })',
      path: "runtime.lambda",
    });
  }

  if (raw.build !== undefined && "target" in raw.build) {
    issues.push({
      message:
        '"build.target" was removed; Voke always builds an ESM bundle for the Lambda Node.js runtime',
      path: "build.target",
    });
  }

  return issues;
};

const assertNoRemovedSettings = (input: VokeConfigInput): void => {
  const issues = removedSettings(input);

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }
};

const defineBuildConfig = (input: VokeConfigInput): VokeBuildConfig => {
  const entrypoint = input.entrypoint ?? "./src/index.ts";

  return {
    entrypoints: unique(input.build?.entrypoints ?? [entrypoint]),
    external: [...(input.build?.external ?? defaultBuildExternal)],
    outdir: input.build?.outdir ?? "./dist",
  };
};

const defineCloudFormationConfig = (
  input: VokeConfigInput
): VokeCloudFormationConfig => ({
  out: input.cloudFormation?.out ?? "./dist/cloudformation.json",
});

const defineDevConfig = (input: VokeConfigInput): VokeDevConfig => ({
  entrypoint: input.dev?.entrypoint ?? input.entrypoint ?? "./src/index.ts",
  environment: input.dev?.environment ?? {},
});

const defaultFunctionMemory = 1024;
const defaultFunctionTimeout = 15;

const defineRuntimeConfig = (input: VokeConfigInput): VokeRuntimeConfig => {
  const memory = input.runtime?.memory ?? defaultFunctionMemory;
  const timeout = input.runtime?.timeout ?? defaultFunctionTimeout;
  const issues = [
    positiveIntegerIssue(memory, "runtime.memory", "MB"),
    positiveIntegerIssue(timeout, "runtime.timeout", "seconds"),
  ].filter((issue) => issue !== undefined);

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return { memory, timeout };
};

const defineRemotesConfig = (
  input: VokeConfigInput,
  stage: string
): Record<string, VokeRemoteConfig> => {
  const remotes: Record<string, VokeRemoteConfig> = {};

  for (const [name, remote] of Object.entries(input.remotes ?? {})) {
    remotes[name] = defineRemoteConfig(name, remote, stage);
  }

  return remotes;
};

export const defineConfig = (input: VokeConfigInput): VokeConfig => {
  assertNoRemovedSettings(input);

  const stage = input.stage ?? readEnv("VOKE_STAGE") ?? "local";
  const remotes = defineRemotesConfig(input, stage);
  const plugins = definePlugins(input.plugins);

  return {
    api: defineApiConfig(input),
    build: defineBuildConfig(input),
    cloudFormation: defineCloudFormationConfig(input),
    dev: defineDevConfig(input),
    entrypoint: input.entrypoint ?? "./src/index.ts",
    environment: mergePluginContributions(
      "environment",
      input.environment,
      plugins
    ),
    name: input.name,
    plugins,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    region: input.region ?? readEnv("AWS_REGION") ?? "us-east-1",
    ...(Object.keys(remotes).length > 0 ? { remotes } : {}),
    resources: mergePluginContributions("resources", input.resources, plugins),
    runtime: defineRuntimeConfig(input),
    stage,
  };
};

export const loadVokeConfig = async (
  options: {
    path?: string;
    cwd?: string;
  } = {}
): Promise<VokeConfig> => {
  const path = options.path ?? "voke.config.ts";
  const cwd = options.cwd ?? process.cwd();
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  const configFile = Bun.file(absolutePath);

  if (!(await configFile.exists())) {
    throw new VokeConfigError(`Voke config file not found: ${absolutePath}`);
  }

  const module = await import(
    `${pathToFileURL(absolutePath).href}?t=${Date.now()}`
  );
  const exportedConfig = module.default;

  if (exportedConfig === undefined) {
    throw new VokeConfigError(
      `Voke config must export a default config from ${absolutePath}`
    );
  }

  return defineConfig(exportedConfig);
};

export const getConfig = (c: Context<VokeEnv>): VokeConfig => {
  const config = c.env.VOKE_CONFIG;

  if (config === undefined) {
    throw new VokeConfigError(
      "Voke config is not available in this request context"
    );
  }

  return config;
};
