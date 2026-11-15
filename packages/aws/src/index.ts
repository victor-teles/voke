import { VokeModelError } from "voke";
import type { VokeModel, VokeProvider } from "voke";

import { createAwsBuildPlan } from "./build";
import { synthesizeCloudFormationFromModel } from "./cloudformation-synthesis";
import { deployAwsStack, removeAwsStack } from "./deploy";
import { createDeployAwsClients } from "./deploy-clients";
import { createAwsDiagnostics } from "./diagnostics";
import {
  findAwsEventSourceAdapter,
  unsupportedEventSourceMessage,
} from "./event-sources";
import type { VokeIssue } from "./event-sources";
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
  readLocalStackOutputs,
} from "./local";
import { awsEmulator } from "./local-aws-emulator";
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
export {
  sns,
  type SnsAwsEvent,
  type SnsEventInvocationInput,
  type SnsEventSourceDefinition,
  type SnsFilterPolicy,
  type SnsFilterPolicyScope,
  type SnsFunctionDefinitionInput,
  type SnsMessage,
  type SnsMessageAttribute,
  type SnsMessageSchema,
  type SnsNotification,
  type SnsRecord,
} from "./sns";
export {
  eventBridge,
  type EventBridgeAwsEvent,
  type EventBridgeEvent,
  type EventBridgeEventInvocationInput,
  type EventBridgeEventSchema,
  type EventBridgeEventSourceDefinition,
  type EventBridgeFunctionDefinitionInput,
  type EventBridgePattern,
} from "./eventbridge";
export {
  schedule,
  type ScheduledEvent,
  type ScheduledEventSchema,
  type ScheduleEnvelope,
  type ScheduleEventInvocationInput,
  type ScheduleEventSourceDefinition,
  type ScheduleFunctionDefinitionInput,
} from "./schedule";

const validateAwsModel = (model: VokeModel): void => {
  const issues: VokeIssue[] = [];

  for (const [functionKey, definition] of Object.entries(model.functions)) {
    for (const [
      eventSourceIndex,
      eventSource,
    ] of definition.eventSources.entries()) {
      const adapter = findAwsEventSourceAdapter(eventSource.type);

      if (adapter === undefined) {
        issues.push({
          message: unsupportedEventSourceMessage(functionKey, eventSource.type),
          path: `functions.${functionKey}.eventSources.${eventSourceIndex}.type`,
        });
        continue;
      }

      issues.push(
        ...adapter.validate({
          eventSource,
          eventSourceIndex,
          functionKey,
          model,
        })
      );
    }
  }

  if (issues.length > 0) {
    throw VokeModelError.validation(issues);
  }

  validateAwsLambdaModel(model);
};

/** Bindings from `voke local bootstrap`'s outputs file; none, with a hint, when it is missing or stale. */
const localStackBindings = async (
  expected: Parameters<typeof readLocalStackOutputs>[0]
): Promise<Record<string, string>> => {
  const bindings = await readLocalStackOutputs(expected);

  if (bindings === undefined) {
    console.error(
      "Local resources are not provisioned. Run: voke local start && voke local bootstrap"
    );
  }

  return bindings ?? {};
};

export interface AwsProviderOptions {
  /** Lambda settings for every Function: runtime, architecture and log retention. */
  lambda?: AwsLambdaOptions;
  /**
   * The Local AWS Provider for `voke local` and `voke dev`. Defaults to the AWS Emulator,
   * `awsEmulator()`; pass `floci()` from "@voke/aws/local" for Floci.
   */
  local?: LocalProvider;
}

export const aws = (options: AwsProviderOptions = {}): VokeProvider => {
  const localProvider = options.local ?? awsEmulator();
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
    diagnostics: createAwsDiagnostics(localProvider),
    local: {
      devEnvironment: async ({ config, endpoint, model, region, stage }) => {
        const environment = await createLocalAwsEnvironment({
          endpoint,
          provider: localProvider,
          region,
        });
        const bindings =
          localProvider.bindings === "outputs"
            ? await localStackBindings({
                endpoint: environment.AWS_ENDPOINT_URL,
                provider: localProvider.name,
                stack: `${config.name}-${stage}`,
              })
            : createLocalResourceBindings(
                synthesizeCloudFormationFromModel(model, { lambda }),
                {
                  accountId: localProvider.defaults.accountId,
                  endpoint: environment.AWS_ENDPOINT_URL,
                  region,
                }
              );

        return {
          environment: { ...environment, ...bindings },
          ...(localProvider.unsetEnvironment === undefined
            ? {}
            : { unsetEnvironment: localProvider.unsetEnvironment }),
        };
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
