import { createAwsLambdaHandler } from "./aws-lambda";
import type {
  AwsLambdaContext,
  AwsLambdaHttpApiV2Event,
  AwsLambdaHttpApiV2Result,
  HonoLikeApp,
  LambdaRequestOptions,
} from "./aws-lambda";
import { defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput } from "./config";

export type VokeApiOptions = LambdaRequestOptions & {
  name?: string;
  config?: VokeConfigInput;
};

export interface VokeApi<TApp extends HonoLikeApp = HonoLikeApp> {
  app: TApp;
  name: string;
  config: VokeConfig;
  fetch: TApp["fetch"];
  handler: (
    event: AwsLambdaHttpApiV2Event,
    context?: AwsLambdaContext
  ) => Promise<AwsLambdaHttpApiV2Result>;
}

export const api = <TApp extends HonoLikeApp>(
  app: TApp,
  options: VokeApiOptions = {}
): VokeApi<TApp> => {
  const name = options.name ?? options.config?.name ?? "api";
  const config = defineConfig(options.config ?? { name });
  const handler = createAwsLambdaHandler(app);

  return {
    app,
    config,
    fetch: app.fetch.bind(app) as TApp["fetch"],
    handler: (event, context) => handler(event, context as AwsLambdaContext),
    name,
  };
};
