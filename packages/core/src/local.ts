import { synthesizeCloudFormation } from "./cloudformation";
import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "./cloudformation";
import { defineConfig, loadVokeConfig } from "./config";
import type { VokeConfigInput } from "./config";
import { toEnvKey } from "./env-key";

export interface LocalAwsEnvironment extends Record<string, string> {
  AWS_ENDPOINT_URL: string;
  VOKE_AWS_ENDPOINT_URL: string;
  AWS_DEFAULT_REGION: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN: string;
  VOKE_LOCAL_PROVIDER: "floci";
  VOKE_INVOKE_RUNTIME: "local";
}

export interface LocalAwsEnvironmentOptions {
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface FlociComposeOptions {
  image?: string;
  port?: number;
  region?: string;
  dataDirectory?: string;
  hostname?: string;
  storageMode?: "memory" | "persistent" | "hybrid" | "wal";
}

export interface LocalBootstrapPlan {
  environment: LocalAwsEnvironment;
  commands: string[][];
}

export interface LocalBootstrapPlanOptions {
  name?: string;
  stage?: string;
  region?: string;
  endpoint?: string;
  config?: VokeConfigInput;
  configPath?: string;
  template?: CloudFormationTemplate;
  templatePath?: string;
}

const defaultLocalEndpoint = "http://localhost:4566";
const defaultLocalRegion = "us-east-1";
const defaultLocalAccountId = "000000000000";

const binding = (
  logicalId: string,
  attribute: string,
  value: string
): { envName: string; value: string } => ({
  envName: `VOKE_RESOURCE_${toEnvKey(logicalId)}_${toEnvKey(attribute)}`,
  value,
});

const resourceBindingFor = (
  logicalId: string,
  resource: CloudFormationResource,
  endpoint: string,
  accountId: string,
  region: string
): { envName: string; value: string } | undefined => {
  if (resource.Type === "AWS::DynamoDB::Table") {
    return binding(logicalId, "name", logicalId);
  }

  if (resource.Type === "AWS::SQS::Queue") {
    return binding(logicalId, "url", `${endpoint}/${accountId}/${logicalId}`);
  }

  if (resource.Type === "AWS::S3::Bucket") {
    return binding(logicalId, "name", logicalId);
  }

  if (resource.Type === "AWS::SNS::Topic") {
    return binding(
      logicalId,
      "arn",
      `arn:aws:sns:${region}:${accountId}:${logicalId}`
    );
  }

  if (resource.Type === "AWS::Events::EventBus") {
    return binding(logicalId, "name", logicalId);
  }

  if (resource.Type === "AWS::SecretsManager::Secret") {
    return binding(
      logicalId,
      "arn",
      `arn:aws:secretsmanager:${region}:${accountId}:secret:${logicalId}`
    );
  }

  if (resource.Type === "AWS::SSM::Parameter") {
    return binding(logicalId, "name", logicalId);
  }

  return undefined;
};

export const createLocalAwsEnvironment = (
  options: LocalAwsEnvironmentOptions = {}
): LocalAwsEnvironment => {
  const endpoint = options.endpoint ?? defaultLocalEndpoint;
  const region = options.region ?? defaultLocalRegion;
  const accessKeyId = options.accessKeyId ?? "test";
  const secretAccessKey = options.secretAccessKey ?? "test";
  const sessionToken = options.sessionToken ?? "test";

  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    AWS_REGION: region,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_SESSION_TOKEN: sessionToken,
    VOKE_AWS_ENDPOINT_URL: endpoint,
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "floci",
  };
};

export const createFlociComposeConfig = (
  options: FlociComposeOptions = {}
): string => {
  const image = options.image ?? "floci/floci:latest";
  const port = options.port ?? 4566;
  const region = options.region ?? defaultLocalRegion;
  const dataDirectory = options.dataDirectory ?? ".voke/local/data";
  const storageMode = options.storageMode ?? "persistent";
  const { hostname } = options;

  return `services:
  floci:
    image: ${image}
    ports:
      - "${port}:4566"
    environment:
      - FLOCI_DEFAULT_REGION=${region}
      - FLOCI_STORAGE_MODE=${storageMode}
${hostname === undefined ? "" : `      - FLOCI_HOSTNAME=${hostname}\n`}    volumes:
      - ${dataDirectory}:/app/data
`;
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
  let config: ReturnType<typeof defineConfig>;

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
    region,
  });
  const directory = templatePath.split("/").slice(0, -1).join("/");

  if (directory !== "") {
    await Bun.$`mkdir -p ${directory}`;
  }

  await Bun.write(templatePath, `${JSON.stringify(template, null, 2)}\n`);

  return {
    commands: [
      [
        "aws",
        "cloudformation",
        "deploy",
        "--stack-name",
        `${name}-${stage}`,
        "--template-file",
        templatePath,
        "--capabilities",
        "CAPABILITY_IAM",
        "--region",
        region,
      ],
    ],
    environment,
  };
};
