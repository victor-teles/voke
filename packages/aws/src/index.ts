import type { VokeModel, VokeProvider } from "voke";

import { createAwsBuildPlan } from "./build";
import { synthesizeCloudFormationFromModel } from "./cloudformation-synthesis";
import { awsRouteAuth } from "./lambda";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "./local";
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
export { parameter, secret } from "./runtime-variables";
export {
  createAwsLambdaHandler,
  handleAwsLambdaRequest,
  type AwsLambdaContext,
  type AwsLambdaHttpApiV2Event,
  type AwsLambdaHttpApiV2Result,
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
  sqsEventSource,
  sqsMessageBatch,
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
};

export const aws = (): VokeProvider => ({
  build: {
    plan: createAwsBuildPlan,
  },
  local: {
    devEnvironment: ({ config, endpoint, model, region }) => {
      const environment = createLocalAwsEnvironment({
        endpoint,
        provider: config.local.provider,
        region,
      });
      const bindings = createLocalResourceBindings(
        synthesizeCloudFormationFromModel(model),
        {
          accountId: config.local.provider.defaults.accountId,
          endpoint: environment.AWS_ENDPOINT_URL,
          region,
        }
      );

      return {
        ...environment,
        ...bindings,
      };
    },
  },
  name: "aws",
  runtime: {
    routeAuth: awsRouteAuth,
    variables: () => [createAwsRuntimeVariableProvider()],
  },
  synthesis: {
    synthesize: ({ model }) => synthesizeCloudFormationFromModel(model),
  },
  validate: validateAwsModel,
});
