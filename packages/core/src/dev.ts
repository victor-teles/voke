import { synthesizeCloudFormation } from "./cloudformation";
import { defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput } from "./config";
import { VokeConfigError } from "./errors";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "./local";

export interface DevPlan {
  command: string[];
  entrypoint: string;
  environment: Record<string, string>;
}

export interface DevPlanOverrides {
  endpoint?: string;
  entrypoint?: string;
  region?: string;
  stage?: string;
}

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
      ...createLocalResourceBindings(template, {
        accountId: config.local.provider.defaults.accountId,
        endpoint: localEnvironment.AWS_ENDPOINT_URL,
        region,
      }),
      VOKE_STAGE: stage,
    },
  };
};
