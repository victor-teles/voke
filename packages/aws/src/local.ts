import { defineConfig, loadVokeConfig } from "voke";
import type { VokeConfig, VokeConfigInput } from "voke";

import { synthesizeCloudFormation } from "./cloudformation-synthesis";
import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "./cloudformation-synthesis";
import {
  createFlociLocalProvider,
  resolveLocalProvider,
} from "./local-provider";
import type {
  FlociComposeOptions,
  LocalAwsEnvironment,
  LocalAwsEnvironmentOptions,
  LocalBootstrapPlan,
  LocalProviderInput,
} from "./local-provider";
import { createResourceBindingName } from "./resources";

export {
  createFlociLocalProvider,
  resolveLocalProvider,
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
  type LocalProviderInput,
} from "./local-provider";

export interface LocalBootstrapPlanOptions {
  name?: string;
  stage?: string;
  region?: string;
  endpoint?: string;
  config?: VokeConfigInput;
  configPath?: string;
  provider?: LocalProviderInput;
  template?: CloudFormationTemplate;
  templatePath?: string;
}

const defaultLocalEndpoint = "http://localhost:4566";
const defaultLocalRegion = "us-east-1";
const defaultLocalAccountId = "000000000000";

const writeTemplate = async (
  templatePath: string,
  template: CloudFormationTemplate
): Promise<void> => {
  const directory = templatePath.split("/").slice(0, -1).join("/");

  if (directory !== "") {
    await Bun.$`mkdir -p ${directory}`;
  }

  await Bun.write(templatePath, `${JSON.stringify(template, null, 2)}\n`);
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
  options: LocalAwsEnvironmentOptions = {}
): LocalAwsEnvironment => {
  const provider = resolveLocalProvider(options.provider);

  return provider.environment(options);
};

export const createFlociComposeConfig = (
  options: FlociComposeOptions = {}
): string => createFlociLocalProvider().composeConfig(options);

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
  let config: VokeConfig;

  if (options.config !== undefined) {
    config = defineConfig(options.config);
  } else if (options.template === undefined) {
    config = await loadVokeConfig({ path: options.configPath });
  } else {
    config = defineConfig({
      name: options.name ?? "api",
      region: options.region,
      stage: options.stage,
    });
  }
  const provider = resolveLocalProvider(
    options.provider ?? config.local.provider
  );
  const name = options.name ?? config.name;
  const stage = options.stage ?? config.stage;
  const region = options.region ?? config.region;
  const template =
    options.template ??
    synthesizeCloudFormation({
      ...config,
      name,
      region,
      stage,
    });
  const templatePath =
    options.templatePath ?? ".voke/local/cloudformation.json";
  const environment = createLocalAwsEnvironment({
    endpoint: options.endpoint,
    provider,
    region,
  });

  await writeTemplate(templatePath, template);

  return provider.bootstrapPlan({
    environment,
    name,
    region,
    stage,
    template,
    templatePath,
  });
};
