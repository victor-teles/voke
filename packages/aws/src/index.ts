import type { VokeModel, VokeProvider } from "voke";

import { createAwsBuildPlan } from "./build";
import { synthesizeCloudFormationFromModel } from "./cloudformation-synthesis";
import { deployAwsStack, removeAwsStack } from "./deploy";
import { createDeployAwsClients } from "./deploy-clients";
import { awsRouteAuth } from "./lambda";
import {
  defineAwsLambdaSettings,
  validateAwsLambdaModel,
} from "./lambda-settings";
import type { AwsLambdaOptions } from "./lambda-settings";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
  createLocalWorkflow,
} from "./local";
import { floci } from "./local-provider";
import type { LocalProvider } from "./local-provider";
import { createAwsRuntimeVariableProvider } from "./runtime-variables";

export {
  createAuthorizers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
  type AuthorizerIdentitySource,
  type AuthorizerRegistry,
  type AuthorizerRegistryInput,
  type AuthorizerRequest,
  type AuthorizerResult,
  type HttpAuthorizerDefinition,
  type JwtAuthorizerDefinition,
  type JwtAuthorizerInput,
  type LambdaAuthorizerDefinition,
  type LambdaAuthorizerInput,
  type LambdaAuthorizerTarget,
  type RequestAuthorizerFunctionDefinition,
  type RequestAuthorizerFunctionInput,
  type RequestAuthorizerHandler,
} from "./authorizers";
export {
  bindResource,
  createAwsClientConfig,
  createResourceBindingName,
  toEnvKey,
  type AwsClientConfig,
  type ResourceBinding,
} from "./resources";
export {
  awsLambda,
  type AwsLambdaArchitecture,
  type AwsLambdaFunctionOptions,
  type AwsLambdaOptions,
  type AwsLambdaRuntime,
  type AwsLogRetentionDays,
} from "./lambda-settings";
export { parameter, secret } from "./runtime-variables";
export type {
  AwsLambdaContext,
  AwsLambdaHttpApiV2Event,
  AwsLambdaHttpApiV2Result,
} from "./lambda";
export {
  createLambdaHandlers,
  type LambdaHandler,
  type LambdaProjectModule,
} from "./lambda-handlers";
export {
  createAwsLambdaInvokeTransport,
  type AwsLambdaInvokeClient,
  type AwsLambdaInvokeTransportOptions,
} from "./lambda-invoke-transport";
export {
  sqs,
  createSqsEventHandler,
  type SqsBatchResult,
  type SqsAwsEvent,
  type SqsEventInvocationInput,
  type SqsEventSourceDefinition,
  type SqsEventSourceOptions,
  type SqsFunctionDefinitionInput,
  type SqsInvalidMessage,
  type SqsMessageBatch,
  type SqsMessageBatchIncludeInvalid,
  type SqsMessageBatchSchema,
  type SqsRecord,
  type SqsValidMessage,
} from "./sqs";

const validateAwsModel = (model: VokeModel): void => {
  for (const [functionName, definition] of Object.entries(model.functions)) {
    for (const eventSource of definition.eventSources) {
      if (eventSource.type !== "sqs") {
        continue;
      }

      const resource = model.resources[eventSource.queue];
      const cloudFormationType =
        resource?.provider?.aws?.properties.cloudFormationType;

      if (resource !== undefined && cloudFormationType !== "AWS::SQS::Queue") {
        throw new Error(
          `Function "${functionName}" SQS event source references resource "${eventSource.queue}", but it is an ${JSON.stringify(cloudFormationType)} resource instead of an "AWS::SQS::Queue".`
        );
      }
    }
  }

  validateAwsLambdaModel(model);
};

export interface AwsProviderOptions {
  /** Lambda settings for every Function: runtime, architecture and log retention. */
  lambda?: AwsLambdaOptions;
  /** The Local AWS Provider for `voke local` and `voke dev`. Defaults to Floci. */
  local?: LocalProvider;
}

export const aws = (options: AwsProviderOptions = {}): VokeProvider => {
  const localProvider = options.local ?? floci();
  const lambda = defineAwsLambdaSettings(options.lambda);

  return {
    build: {
      plan: createAwsBuildPlan,
    },
    deploy: {
      deploy: async (input) =>
        await deployAwsStack(input, {
          clients: await createDeployAwsClients({
            region: input.region ?? input.config.region,
          }),
          lambda,
        }),
      remove: async (input) =>
        await removeAwsStack(input, {
          clients: await createDeployAwsClients({
            region: input.region ?? input.config.region,
          }),
        }),
    },
    local: {
      devEnvironment: ({ endpoint, model, region }) => {
        const environment = createLocalAwsEnvironment({
          endpoint,
          provider: localProvider,
          region,
        });
        const bindings = createLocalResourceBindings(
          synthesizeCloudFormationFromModel(model, { lambda }),
          {
            accountId: localProvider.defaults.accountId,
            endpoint: environment.AWS_ENDPOINT_URL,
            region,
          }
        );

        return { environment: { ...environment, ...bindings } };
      },
      workflow: createLocalWorkflow(localProvider),
    },
    name: "aws",
    runtime: {
      routeAuth: awsRouteAuth,
      variables: () => [createAwsRuntimeVariableProvider()],
    },
    synthesis: {
      synthesize: ({ model }) =>
        synthesizeCloudFormationFromModel(model, { lambda }),
    },
    validate: validateAwsModel,
  };
};
