import type { CloudFormationTemplate } from "./cloudformation-synthesis";

export interface LocalAwsEnvironment extends Record<string, string> {
  AWS_ENDPOINT_URL: string;
  VOKE_AWS_ENDPOINT_URL: string;
  AWS_DEFAULT_REGION: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN: string;
  VOKE_LOCAL_PROVIDER: string;
  VOKE_INVOKE_RUNTIME: "local";
}

export interface LocalAwsEnvironmentOptions {
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface LocalProviderComposeOptions {
  image?: string;
  port?: number;
  region?: string;
  dataDirectory?: string;
  hostname?: string;
  storageMode?: "memory" | "persistent" | "hybrid" | "wal";
}

export type FlociComposeOptions = LocalProviderComposeOptions;

export interface FlociLocalProviderOptions extends FlociComposeOptions {
  endpoint?: string;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface LocalBootstrapPlan {
  environment: LocalAwsEnvironment;
  commands: string[][];
}

export interface LocalProviderDefaults {
  accountId: string;
  endpoint: string;
  region: string;
}

export interface LocalProviderCommandOptions {
  composePath: string;
}

export interface LocalProviderBootstrapPlanOptions {
  environment: LocalAwsEnvironment;
  name: string;
  region: string;
  stage: string;
  template: CloudFormationTemplate;
  templatePath: string;
}

export interface LocalProvider {
  name: string;
  defaults: LocalProviderDefaults;
  bootstrapPlan: (
    options: LocalProviderBootstrapPlanOptions
  ) => LocalBootstrapPlan | Promise<LocalBootstrapPlan>;
  composeConfig: (options?: LocalProviderComposeOptions) => string;
  environment: (options?: LocalAwsEnvironmentOptions) => LocalAwsEnvironment;
  resetCommand: (options: LocalProviderCommandOptions) => string[];
  startCommand: (options: LocalProviderCommandOptions) => string[];
  stopCommand: (options: LocalProviderCommandOptions) => string[];
}

export class LocalProviderError extends Error {
  provider: string;
  command: string[];
  override cause: unknown;

  constructor(options: {
    provider: string;
    command: string[];
    message: string;
    cause: unknown;
  }) {
    super(options.message);
    this.name = "LocalProviderError";
    this.provider = options.provider;
    this.command = options.command;
    this.cause = options.cause;
  }
}

const defaultLocalEndpoint = "http://localhost:4566";
const defaultLocalRegion = "us-east-1";
const defaultLocalAccountId = "000000000000";
const defaultLocalCredential = "test";

/** The Floci Local AWS Provider (Docker Compose), Voke's default for local development. */
export const floci = (
  defaults: FlociLocalProviderOptions = {}
): LocalProvider => ({
  bootstrapPlan: ({ environment, name, region, stage, templatePath }) => ({
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
  }),
  composeConfig: (options = {}) => {
    const image = options.image ?? defaults.image ?? "floci/floci:latest";
    const port = options.port ?? defaults.port ?? 4566;
    const region = options.region ?? defaults.region ?? defaultLocalRegion;
    const dataDirectory =
      options.dataDirectory ?? defaults.dataDirectory ?? ".voke/local/data";
    const storageMode =
      options.storageMode ?? defaults.storageMode ?? "persistent";
    const hostname = options.hostname ?? defaults.hostname;

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
  },
  defaults: {
    accountId: defaults.accountId ?? defaultLocalAccountId,
    endpoint: defaults.endpoint ?? defaultLocalEndpoint,
    region: defaults.region ?? defaultLocalRegion,
  },
  environment: (options = {}) => {
    const endpoint =
      options.endpoint ?? defaults.endpoint ?? defaultLocalEndpoint;
    const region = options.region ?? defaults.region ?? defaultLocalRegion;
    const accessKeyId =
      options.accessKeyId ?? defaults.accessKeyId ?? defaultLocalCredential;
    const secretAccessKey =
      options.secretAccessKey ??
      defaults.secretAccessKey ??
      defaultLocalCredential;
    const sessionToken =
      options.sessionToken ?? defaults.sessionToken ?? defaultLocalCredential;

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
  },
  name: "floci",
  resetCommand: ({ composePath }) => [
    "docker",
    "compose",
    "-f",
    composePath,
    "down",
    "-v",
  ],
  startCommand: ({ composePath }) => [
    "docker",
    "compose",
    "-f",
    composePath,
    "up",
    "-d",
  ],
  stopCommand: ({ composePath }) => [
    "docker",
    "compose",
    "-f",
    composePath,
    "down",
  ],
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The message a failed local command reports, with guidance for the Local AWS Provider. */
export const localProviderFailureMessage = (options: {
  cause: unknown;
  command: string[];
  localCommand: string;
  provider: LocalProvider;
}): string => {
  const commandText = options.command.join(" ");
  const base = `Voke local ${options.localCommand} failed while running: ${commandText}. ${errorMessage(options.cause)}`;

  if (options.provider.name !== "floci") {
    return `${base}\nLocal provider: ${options.provider.name}. Check this provider's local command configuration.`;
  }

  if (options.localCommand === "bootstrap") {
    return `${base}\nFloci is Voke's default optional local AWS provider. Make sure Floci is running with "voke local start", then retry "voke local bootstrap". You can also pass a Local AWS Provider: aws({ local: ... })`;
  }

  return `${base}\nFloci is Voke's default optional local AWS provider. Make sure Docker Compose is installed and Docker is running, then retry "voke local ${options.localCommand}". You can also pass a Local AWS Provider: aws({ local: ... })`;
};
