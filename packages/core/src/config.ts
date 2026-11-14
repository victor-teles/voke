import type { Context } from "hono";

import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import type {
  VokeModelProviderExtensionRecord,
  VokeModelRecord,
} from "./model";
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
  provider?: VokeProvider;
  remotes?: Record<string, VokeRemoteConfig>;
  /** Infrastructure resources (queues, tables, buckets, ...) the project declares. */
  resources: Record<string, VokeResourceInput>;
  runtime: VokeRuntimeConfig;
}

export interface VokeApiConfig {
  name: string;
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

export type VokeNodeRuntime = "nodejs22.x" | "nodejs24.x";

export interface VokeRuntimeConfig {
  lambda: VokeNodeRuntime;
}

export interface VokeConfigInput {
  name: string;
  api?: Partial<VokeApiConfig>;
  stage?: string;
  region?: string;
  entrypoint?: string;
  build?: Partial<VokeBuildConfig>;
  cloudFormation?: Partial<VokeCloudFormationConfig>;
  dev?: Partial<VokeDevConfig>;
  provider?: VokeProvider;
  remotes?: Record<string, VokeRemoteConfig | VokeRemoteConfigInput>;
  runtime?: Partial<VokeRuntimeConfig>;
  environment?: Record<string, string>;
  resources?: Record<string, VokeResourceInput>;
}

const defineApiConfig = (input: VokeConfigInput): VokeApiConfig => ({
  name: input.api?.name ?? input.name,
});

export const createHandlerNameFromEntrypoint = (entrypoint: string): string => {
  const fileName = entrypoint.split("/").at(-1) ?? "index.ts";
  const moduleName = fileName.replace(/\.[^.]+$/u, "");

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

const isNodeRuntime = (runtime: string): runtime is VokeNodeRuntime =>
  runtime === "nodejs22.x" || runtime === "nodejs24.x";

const defineNodeRuntime = (runtime: string): VokeNodeRuntime => {
  if (!isNodeRuntime(runtime)) {
    throw VokeConfigError.validation([
      {
        message: `expected one of "nodejs22.x", "nodejs24.x"; received ${JSON.stringify(runtime)}`,
        path: "runtime.lambda",
      },
    ]);
  }

  return runtime;
};

const defineRuntimeConfig = (input: VokeConfigInput): VokeRuntimeConfig => ({
  lambda: defineNodeRuntime(input.runtime?.lambda ?? "nodejs22.x"),
});

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

  return {
    api: defineApiConfig(input),
    build: defineBuildConfig(input),
    cloudFormation: defineCloudFormationConfig(input),
    dev: defineDevConfig(input),
    entrypoint: input.entrypoint ?? "./src/index.ts",
    environment: { ...input.environment },
    name: input.name,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    region: input.region ?? readEnv("AWS_REGION") ?? "us-east-1",
    ...(Object.keys(remotes).length > 0 ? { remotes } : {}),
    resources: { ...input.resources },
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
  const cwd = options.cwd ?? readEnv("PWD") ?? ".";
  const absolutePath = path.startsWith("/") ? path : `${cwd}/${path}`;
  const configFile = Bun.file(absolutePath);

  if (!(await configFile.exists())) {
    throw new VokeConfigError(`Voke config file not found: ${absolutePath}`);
  }

  const module = await import(
    `${new URL(`file://${absolutePath}`).href}?t=${Date.now()}`
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
