import type { Context } from "hono";

import type { StackResourceDefinition } from "./cloudformation";
import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import { defineFunctions } from "./invoke";
import type {
  AnyFunctionDefinition,
  FunctionRegistry,
  FunctionRegistryInput,
} from "./invoke";
import { resolveLocalProvider } from "./local-provider";
import type { LocalProvider, LocalProviderInput } from "./local-provider";

export interface VokeConfig {
  api: VokeApiConfig;
  name: string;
  stage: string;
  region: string;
  entrypoint: string;
  build: VokeBuildConfig;
  cloudFormation: VokeCloudFormationConfig;
  dev: VokeDevConfig;
  functions: FunctionRegistry | FunctionRegistryInput;
  local: VokeLocalConfig;
  runtime: VokeRuntimeConfig;
}

export interface VokeApiConfig {
  name: string;
  protocol: "http";
  function: string;
  routes: string[];
}

export interface VokeBuildConfig {
  entrypoints: string[];
  outdir: string;
  target: "bun";
}

export interface VokeCloudFormationConfig {
  out: string;
  handler: string;
  environment: Record<string, string>;
  resources: Record<string, StackResourceDefinition>;
}

export interface VokeDevConfig {
  entrypoint: string;
  environment: Record<string, string>;
}

export interface VokeLocalConfig {
  provider: LocalProvider;
  providerOptional: boolean;
}

export interface VokeLocalConfigInput {
  provider: LocalProviderInput;
  providerOptional: boolean;
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
  functions?: FunctionRegistry | FunctionRegistryInput;
  local?: Partial<VokeLocalConfigInput>;
  runtime?: Partial<VokeRuntimeConfig>;
  handler?: string;
  environment?: Record<string, string>;
  resources?: Record<string, StackResourceDefinition>;
}

const defineApiConfig = (input: VokeConfigInput): VokeApiConfig => ({
  function: input.api?.function ?? "api",
  name: input.api?.name ?? input.name,
  protocol: input.api?.protocol ?? "http",
  routes: input.api?.routes ?? ["$default"],
});

export const createHandlerNameFromEntrypoint = (entrypoint: string): string => {
  const fileName = entrypoint.split("/").at(-1) ?? "index.ts";
  const moduleName = fileName.replace(/\.[^.]+$/u, "");

  return `${moduleName}.handler`;
};

const unique = (values: string[]): string[] => [...new Set(values)];

const defineBuildConfig = (input: VokeConfigInput): VokeBuildConfig => {
  const entrypoint = input.entrypoint ?? "./src/index.ts";
  const functionEntrypoints = Object.entries(input.functions ?? {})
    .filter(([key]) => key !== "invoke")
    .map(([, definition]) => definition as AnyFunctionDefinition)
    .map((definition) => definition.synthesis?.entrypoint)
    .filter((value): value is string => value !== undefined);

  return {
    entrypoints: unique(
      input.build?.entrypoints ?? [entrypoint, ...functionEntrypoints]
    ),
    outdir: input.build?.outdir ?? "./dist",
    target: input.build?.target ?? "bun",
  };
};

const defineCloudFormationConfig = (
  input: VokeConfigInput
): VokeCloudFormationConfig => {
  const cloudFormation = input.cloudFormation ?? {};

  return {
    environment: {
      ...input.environment,
      ...cloudFormation.environment,
    },
    handler:
      cloudFormation.handler ??
      input.handler ??
      createHandlerNameFromEntrypoint(input.entrypoint ?? "./src/index.ts"),
    out: cloudFormation.out ?? "./dist/cloudformation.json",
    resources: {
      ...input.resources,
      ...cloudFormation.resources,
    },
  };
};

const defineDevConfig = (input: VokeConfigInput): VokeDevConfig => ({
  entrypoint: input.dev?.entrypoint ?? input.entrypoint ?? "./src/index.ts",
  environment: input.dev?.environment ?? {},
});

const defineLocalConfig = (input: VokeConfigInput): VokeLocalConfig => ({
  provider: resolveLocalProvider(input.local?.provider),
  providerOptional: input.local?.providerOptional ?? true,
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

export const defineConfig = (input: VokeConfigInput): VokeConfig => ({
  api: defineApiConfig(input),
  build: defineBuildConfig(input),
  cloudFormation: defineCloudFormationConfig(input),
  dev: defineDevConfig(input),
  entrypoint: input.entrypoint ?? "./src/index.ts",
  functions: input.functions ?? defineFunctions({}),
  local: defineLocalConfig(input),
  name: input.name,
  region: input.region ?? Bun.env.AWS_REGION ?? "us-east-1",
  runtime: defineRuntimeConfig(input),
  stage: input.stage ?? Bun.env.VOKE_STAGE ?? Bun.env.STAGE ?? "local",
});

export const loadVokeConfig = async (
  options: {
    path?: string;
    cwd?: string;
  } = {}
): Promise<VokeConfig> => {
  const path = options.path ?? "voke.config.ts";
  const cwd = options.cwd ?? Bun.env.PWD ?? ".";
  const absolutePath = path.startsWith("/") ? path : `${cwd}/${path}`;
  const configFile = Bun.file(absolutePath);

  if (!(await configFile.exists())) {
    throw new VokeConfigError(`Voke config file not found: ${absolutePath}`);
  }

  const module = await import(
    `${new URL(`file://${absolutePath}`).href}?t=${Date.now()}`
  );
  const exportedConfig = module.default ?? module.config;

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
