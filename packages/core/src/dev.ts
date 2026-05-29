import { defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput } from "./config";
import { VokeConfigError } from "./errors";
import { createInternalModel } from "./model";
import { remoteEnvironment } from "./remote";

export interface DevPlan {
  command: string[];
  entrypoint: string;
  environment: Record<string, string>;
}

export interface DevPlanOverrides {
  endpoint?: string;
  entrypoint?: string;
  hostname?: string;
  port?: number;
  region?: string;
  stage?: string;
}

const createProviderLocalEnvironment = (
  config: VokeConfig,
  overrides: {
    endpoint?: string;
    entrypoint: string;
    hasResources: boolean;
    region: string;
    stage: string;
  }
): Record<string, string> => {
  const { provider } = config;
  const devEnvironment = provider?.local?.devEnvironment;

  if (devEnvironment === undefined) {
    if (!overrides.hasResources && provider === undefined) {
      return {};
    }

    throw new VokeConfigError(
      provider === undefined
        ? "No provider configured for dev local environment."
        : `Provider "${provider.name}" does not support dev local environment.`
    );
  }

  const devConfig = defineConfig({
    ...config,
    entrypoint: overrides.entrypoint,
    region: overrides.region,
    stage: overrides.stage,
  });

  return devEnvironment({
    config: devConfig,
    endpoint: overrides.endpoint,
    model: createInternalModel(devConfig),
    region: overrides.region,
    stage: overrides.stage,
  });
};

const createDevOrigin = (
  config: VokeConfig,
  overrides: DevPlanOverrides
): string => {
  const hasOriginOverride =
    overrides.hostname !== undefined || overrides.port !== undefined;

  if (hasOriginOverride) {
    const hostname = overrides.hostname ?? "localhost";
    const port =
      overrides.port ??
      Number(config.dev.environment.PORT ?? Bun.env.PORT ?? 3000);

    return `http://${hostname}:${port}`;
  }

  if (config.dev.environment.VOKE_DEV_ORIGIN !== undefined) {
    return config.dev.environment.VOKE_DEV_ORIGIN;
  }

  if (Bun.env.VOKE_DEV_ORIGIN !== undefined) {
    return Bun.env.VOKE_DEV_ORIGIN;
  }

  const hostname = overrides.hostname ?? Bun.env.HOST ?? "localhost";
  const port =
    overrides.port ??
    Number(config.dev.environment.PORT ?? Bun.env.PORT ?? 3000);

  return `http://${hostname}:${port}`;
};

export const createDevPlan = async (
  input: VokeConfig | VokeConfigInput,
  overrides: DevPlanOverrides = {}
): Promise<DevPlan> => {
  const config = defineConfig(input);
  const entrypoint = overrides.entrypoint ?? config.dev.entrypoint;

  if (!(await Bun.file(entrypoint).exists())) {
    throw new VokeConfigError(`Voke dev entrypoint not found: ${entrypoint}`);
  }

  const region = overrides.region ?? config.region;
  const stage = overrides.stage ?? config.stage;
  const origin = createDevOrigin(config, overrides);
  const hasResources = Object.keys(config.cloudFormation.resources).length > 0;
  const providerEnvironment = createProviderLocalEnvironment(config, {
    endpoint: overrides.endpoint,
    entrypoint,
    hasResources,
    region,
    stage,
  });

  return {
    command: ["bun", "--hot", entrypoint],
    entrypoint,
    environment: {
      ...providerEnvironment,
      ...config.cloudFormation.environment,
      ...config.dev.environment,
      ...remoteEnvironment(config.remotes ?? {}),
      VOKE_DEV_ORIGIN: origin,
      VOKE_DEV_STARTED_AT: String(Date.now()),
      VOKE_DEV_SUMMARY: "1",
      VOKE_STAGE: stage,
    },
  };
};
