import type { Context } from "hono";

import type { StackResourceDefinition } from "./cloudformation";
import type { VokeEnv } from "./context";

export interface VokeConfig {
  name: string;
  stage: string;
  region: string;
  entrypoint: string;
  build: VokeBuildConfig;
  cloudFormation: VokeCloudFormationConfig;
}

export interface VokeBuildConfig {
  outdir: string;
}

export interface VokeCloudFormationConfig {
  out: string;
  handler: string;
  environment: Record<string, string>;
  resources: Record<string, StackResourceDefinition>;
}

export interface VokeConfigInput {
  name: string;
  stage?: string;
  region?: string;
  entrypoint?: string;
  build?: Partial<VokeBuildConfig>;
  cloudFormation?: Partial<VokeCloudFormationConfig>;
  handler?: string;
  environment?: Record<string, string>;
  resources?: Record<string, StackResourceDefinition>;
}

export const defineConfig = (input: VokeConfigInput): VokeConfig => {
  const cloudFormation = input.cloudFormation ?? {};

  return {
    build: {
      outdir: input.build?.outdir ?? "./dist",
    },
    cloudFormation: {
      environment: {
        ...input.environment,
        ...cloudFormation.environment,
      },
      handler: cloudFormation.handler ?? input.handler ?? "index.handler",
      out: cloudFormation.out ?? "./dist/cloudformation.json",
      resources: {
        ...input.resources,
        ...cloudFormation.resources,
      },
    },
    entrypoint: input.entrypoint ?? "./src/index.ts",
    name: input.name,
    region: input.region ?? Bun.env.AWS_REGION ?? "us-east-1",
    stage: input.stage ?? Bun.env.VOKE_STAGE ?? Bun.env.STAGE ?? "local",
  };
};

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
    throw new Error(`Voke config file not found: ${absolutePath}`);
  }

  const module = await import(
    `${new URL(`file://${absolutePath}`).href}?t=${Date.now()}`
  );
  const exportedConfig = module.default ?? module.config;

  if (exportedConfig === undefined) {
    throw new Error(
      `Voke config must export a default config from ${absolutePath}`
    );
  }

  return defineConfig(exportedConfig);
};

export const getConfig = (c: Context<VokeEnv>): VokeConfig => {
  const config = c.env.VOKE_CONFIG;

  if (config === undefined) {
    throw new Error("Voke config is not available in this request context");
  }

  return config;
};
