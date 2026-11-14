import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ProviderLocalWorkflow,
  ProviderLocalWorkflowContext,
  VokeModel,
} from "voke";

import { synthesizeCloudFormationFromModel } from "./cloudformation-synthesis";
import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "./cloudformation-synthesis";
import {
  LocalProviderError,
  localProviderFailureMessage,
} from "./local-provider";
import type {
  LocalAwsEnvironment,
  LocalAwsEnvironmentOptions,
  LocalBootstrapPlan,
  LocalProvider,
} from "./local-provider";
import { createResourceBindingName } from "./resources";

export {
  floci,
  LocalProviderError,
  type FlociComposeOptions,
  type FlociLocalProviderOptions,
  type LocalAwsEnvironment,
  type LocalAwsEnvironmentOptions,
  type LocalBootstrapPlan,
  type LocalProvider,
  type LocalProviderBootstrapPlanOptions,
  type LocalProviderCommandOptions,
  type LocalProviderComposeOptions,
  type LocalProviderDefaults,
} from "./local-provider";

interface LocalBootstrapPlanBaseOptions {
  endpoint?: string;
  name: string;
  provider: LocalProvider;
  region: string;
  stage: string;
  templatePath?: string;
}

/** Provision the resources of a model, or of a ready template (an escape hatch). */
export type LocalBootstrapPlanOptions = LocalBootstrapPlanBaseOptions &
  (
    | { model: VokeModel; template?: undefined }
    | { model?: undefined; template: CloudFormationTemplate }
  );

const defaultLocalEndpoint = "http://localhost:4566";
const defaultLocalRegion = "us-east-1";
const defaultLocalAccountId = "000000000000";

const writeFileCreatingDirectory = async (
  path: string,
  contents: string
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
};

const binding = (
  resource: string,
  attribute: string,
  value: string
): { envName: string; value: string } => ({
  envName: createResourceBindingName(resource, attribute),
  value,
});

const metadataBinding = (
  logicalId: string,
  resource: CloudFormationResource
): { attribute: string; resource: string } | undefined => {
  const metadata = resource.Metadata?.VokeBinding;

  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return undefined;
  }

  const attribute = metadata.Attribute;
  const name = metadata.Resource;

  if (typeof attribute !== "string" || typeof name !== "string") {
    return undefined;
  }

  return { attribute, resource: name || logicalId };
};

const resourceBindingFor = (
  logicalId: string,
  resource: CloudFormationResource,
  endpoint: string,
  accountId: string,
  region: string
): { envName: string; value: string } | undefined => {
  const modelBinding = metadataBinding(logicalId, resource);
  const bindingResource = modelBinding?.resource ?? logicalId;
  const bindingAttribute = modelBinding?.attribute;

  if (resource.Type === "AWS::DynamoDB::Table") {
    return binding(bindingResource, bindingAttribute ?? "name", logicalId);
  }

  if (resource.Type === "AWS::SQS::Queue") {
    return binding(
      bindingResource,
      bindingAttribute ?? "url",
      `${endpoint}/${accountId}/${logicalId}`
    );
  }

  if (resource.Type === "AWS::S3::Bucket") {
    return binding(bindingResource, bindingAttribute ?? "name", logicalId);
  }

  if (resource.Type === "AWS::SNS::Topic") {
    return binding(
      bindingResource,
      bindingAttribute ?? "arn",
      `arn:aws:sns:${region}:${accountId}:${logicalId}`
    );
  }

  if (resource.Type === "AWS::Events::EventBus") {
    return binding(bindingResource, bindingAttribute ?? "name", logicalId);
  }

  if (resource.Type === "AWS::SecretsManager::Secret") {
    return binding(
      bindingResource,
      bindingAttribute ?? "id",
      bindingAttribute === "arn"
        ? `arn:aws:secretsmanager:${region}:${accountId}:secret:${logicalId}`
        : logicalId
    );
  }

  if (resource.Type === "AWS::SSM::Parameter") {
    return binding(bindingResource, bindingAttribute ?? "name", logicalId);
  }

  return undefined;
};

export const createLocalAwsEnvironment = (
  options: LocalAwsEnvironmentOptions & { provider: LocalProvider }
): LocalAwsEnvironment => {
  const { provider, ...environmentOptions } = options;

  return provider.environment(environmentOptions);
};

export const createLocalResourceBindings = (
  template: CloudFormationTemplate,
  options: { endpoint?: string; accountId?: string; region?: string } = {}
): Record<string, string> => {
  const endpoint = options.endpoint ?? defaultLocalEndpoint;
  const accountId = options.accountId ?? defaultLocalAccountId;
  const region = options.region ?? defaultLocalRegion;
  const bindings: Record<string, string> = {};

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const resourceBinding = resourceBindingFor(
      logicalId,
      resource,
      endpoint,
      accountId,
      region
    );

    if (resourceBinding === undefined) {
      continue;
    }

    bindings[resourceBinding.envName] = resourceBinding.value;
  }

  return bindings;
};

export const createLocalBootstrapPlan = async (
  options: LocalBootstrapPlanOptions
): Promise<LocalBootstrapPlan> => {
  const template =
    options.template === undefined
      ? synthesizeCloudFormationFromModel(options.model)
      : options.template;
  const templatePath =
    options.templatePath ?? ".voke/local/cloudformation.json";
  const environment = createLocalAwsEnvironment({
    endpoint: options.endpoint,
    provider: options.provider,
    region: options.region,
  });

  await writeFileCreatingDirectory(
    templatePath,
    `${JSON.stringify(template, null, 2)}\n`
  );

  return await options.provider.bootstrapPlan({
    environment,
    name: options.name,
    region: options.region,
    stage: options.stage,
    template,
    templatePath,
  });
};

const defaultComposePath = ".voke/local/docker-compose.yml";

const runLocalCommand = async (
  provider: LocalProvider,
  context: ProviderLocalWorkflowContext,
  localCommand: string,
  command: string[],
  env?: Record<string, string>
): Promise<void> => {
  try {
    await context.run(command, { env });
  } catch (error) {
    throw new LocalProviderError({
      cause: error,
      command,
      message: localProviderFailureMessage({
        cause: error,
        command,
        localCommand,
        provider,
      }),
      provider: provider.name,
    });
  }
};

/**
 * `voke local start|stop|reset|bootstrap` for a Local AWS Provider. `start` writes the compose file
 * (`--compose`, `--data`, `--hostname`, `--image`, `--port`, `--region`) before starting it;
 * `bootstrap` provisions the project's resources from its model (`--endpoint`, `--template`).
 */
// The extra `voke local` flags this workflow reads; voke rejects any other flag.
const localWorkflowFlags = {
  compose: `Docker Compose file. Default: ${defaultComposePath}`,
  data: "Emulator data directory. Default: .voke/local/data",
  endpoint: "Local AWS endpoint for bootstrap",
  hostname: "Emulator hostname",
  image: "Emulator container image",
  port: "Emulator port",
  template:
    "Template written by bootstrap. Default: .voke/local/cloudformation.json",
} as const;

export const createLocalWorkflow = (
  provider: LocalProvider
): ProviderLocalWorkflow => {
  const composePath = (context: ProviderLocalWorkflowContext): string =>
    context.options.compose ?? defaultComposePath;

  return {
    bootstrap: async (context) => {
      const { config } = context;
      const plan = await createLocalBootstrapPlan({
        endpoint: context.options.endpoint,
        model: context.model,
        name: config.name,
        provider,
        region: config.region,
        stage: config.stage,
        templatePath:
          context.options.template ?? ".voke/local/cloudformation.json",
      });

      for (const command of plan.commands) {
        await runLocalCommand(
          provider,
          context,
          "bootstrap",
          command,
          plan.environment
        );
      }
    },
    flags: localWorkflowFlags,
    reset: async (context) => {
      await runLocalCommand(
        provider,
        context,
        "reset",
        provider.resetCommand({ composePath: composePath(context) })
      );
    },
    start: async (context) => {
      const { options } = context;

      await writeFileCreatingDirectory(
        composePath(context),
        provider.composeConfig({
          dataDirectory: options.data ?? ".voke/local/data",
          hostname: options.hostname,
          image: options.image,
          port: options.port === undefined ? undefined : Number(options.port),
          region: options.region,
        })
      );
      await runLocalCommand(
        provider,
        context,
        "start",
        provider.startCommand({ composePath: composePath(context) })
      );
    },
    stop: async (context) => {
      await runLocalCommand(
        provider,
        context,
        "stop",
        provider.stopCommand({ composePath: composePath(context) })
      );
    },
  };
};
