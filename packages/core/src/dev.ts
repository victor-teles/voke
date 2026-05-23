import { synthesizeCloudFormation } from "./cloudformation";
import { defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput } from "./config";
import { VokeConfigError } from "./errors";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "./local";
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
  const template = synthesizeCloudFormation({
    ...config,
    entrypoint,
    region,
    stage,
  });
  const localEnvironment = createLocalAwsEnvironment({
    endpoint: overrides.endpoint,
    provider: config.local.provider,
    region,
  });

  return {
    command: ["bun", "--hot", entrypoint],
    entrypoint,
    environment: {
      ...localEnvironment,
      ...config.cloudFormation.environment,
      ...config.dev.environment,
      ...remoteEnvironment(config.remotes ?? {}),
      ...createLocalResourceBindings(template, {
        accountId: config.local.provider.defaults.accountId,
        endpoint: localEnvironment.AWS_ENDPOINT_URL,
        region,
      }),
      VOKE_DEV_ORIGIN: origin,
      VOKE_DEV_STARTED_AT: String(Date.now()),
      VOKE_DEV_SUMMARY: "1",
      VOKE_STAGE: stage,
    },
  };
};
