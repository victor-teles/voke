// Deploy-time module: the full AWS Provider for the CLI. The Lambda Bundle resolves `#provider` to
// `./provider-runtime.ts` instead (the `voke-runtime` condition), so nothing here reaches it.
import { VokeModelError } from "voke";
import type { VokeModel, VokeProvider } from "voke";

import { createAwsBuildPlan } from "./build";
import { synthesizeCloudFormationFromModel } from "./cloudformation-synthesis";
import { deployAwsStack, removeAwsStack } from "./deploy";
import { createDeployAwsClients } from "./deploy-clients";
import { createAwsDiagnostics } from "./diagnostics";
import { unsupportedEventSourceMessage } from "./event-source-runtime";
import { findAwsEventSourceAdapter } from "./event-sources";
import type { VokeIssue } from "./event-sources";
import {
  defineAwsLambdaSettings,
  validateAwsLambdaModel,
} from "./lambda-settings";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
  createLocalWorkflow,
  readLocalStackOutputs,
} from "./local";
import { awsEmulator } from "./local-aws-emulator";
import { pluginRecordIssues } from "./plugin-records";
import { awsRuntimeCapabilities } from "./provider-runtime";
import type { AwsProviderOptions } from "./provider-runtime";

export type { AwsProviderOptions } from "./provider-runtime";

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

  issues.push(...pluginRecordIssues(model));

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

export const aws = (options: AwsProviderOptions = {}): VokeProvider => {
  const localProvider = options.local ?? awsEmulator();
  const lambda = defineAwsLambdaSettings(options.lambda);
  const { retainData } = options;

  return {
    ...awsRuntimeCapabilities(),
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
          ...(retainData === undefined ? {} : { retainData }),
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
    synthesis: {
      synthesize: ({ model }) =>
        synthesizeCloudFormationFromModel(model, {
          lambda,
          ...(retainData === undefined ? {} : { retainData }),
        }),
    },
    validate: validateAwsModel,
  };
};
