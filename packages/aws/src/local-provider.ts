import type { ProviderCommandRunner } from "voke";

import type { CloudFormationTemplate } from "./cloudformation-synthesis";

/**
 * The environment that points AWS SDK clients at a Local AWS Provider. Floci adds fixed dummy
 * credentials; the AWS Emulator adds paths to the credentials and CA files it generates.
 */
export interface LocalAwsEnvironment extends Record<string, string> {
  AWS_ENDPOINT_URL: string;
  VOKE_AWS_ENDPOINT_URL: string;
  AWS_DEFAULT_REGION: string;
  AWS_REGION: string;
  VOKE_LOCAL_PROVIDER: string;
  VOKE_INVOKE_RUNTIME: "local";
}

export interface LocalAwsEnvironmentOptions {
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** The Local AWS Provider's state directory. Default: `<cwd>/.voke/local/<provider name>`. */
  directory?: string;
}

/** What a Local AWS Provider's lifecycle steps receive from `voke local`. */
export interface LocalProviderLifecycleOptions {
  /** Absolute state directory: `<project>/.voke/local/<provider name>`. */
  directory: string;
  /** The `voke local` flags. */
  options: Readonly<Record<string, string>>;
  region: string;
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

export interface LocalProviderBootstrapPlanOptions {
  environment: LocalAwsEnvironment;
  name: string;
  region: string;
  stage: string;
  template: CloudFormationTemplate;
  templatePath: string;
}

/**
 * A Local AWS Provider: emulates AWS services for `voke local` and `voke dev`. This interface is
 * the local layer's escape hatch for emulators Voke does not ship.
 */
export interface LocalProvider {
  name: string;
  defaults: LocalProviderDefaults;
  /**
   * Where `voke dev` gets resource names: `"outputs"` reads the stack outputs that bootstrap
   * writes to `.voke/local/outputs.json` (bootstrap provisions resources only); `"guessed"`
   * derives them from logical ids (bootstrap provisions the full template).
   */
  bindings: "outputs" | "guessed";
  /** The commands that provision a template. */
  bootstrapPlan: (
    options: LocalProviderBootstrapPlanOptions
  ) => LocalBootstrapPlan | Promise<LocalBootstrapPlan>;
  environment: (
    options?: LocalAwsEnvironmentOptions
  ) => LocalAwsEnvironment | Promise<LocalAwsEnvironment>;
  /** Files written before start, keyed by path. */
  files: (options: LocalProviderLifecycleOptions) => Record<string, string>;
  /** Extra `voke local` flags this provider reads, with a description. */
  flags?: Readonly<Record<string, string>>;
  /** Runs before the start commands, for example to build an image only when it is missing. */
  prepareStart?: (
    options: LocalProviderLifecycleOptions,
    run: ProviderCommandRunner
  ) => Promise<void>;
  resetCommands: (options: LocalProviderLifecycleOptions) => string[][];
  startCommands: (options: LocalProviderLifecycleOptions) => string[][];
  stopCommands: (options: LocalProviderLifecycleOptions) => string[][];
  /** Variables removed from every command and from the `voke dev` child, such as real credentials. */
  unsetEnvironment?: readonly string[];
  /** Resolves once the emulator answers; runs after start and reset. */
  waitUntilReady?: (options: LocalProviderLifecycleOptions) => Promise<void>;
}

/** Floci also exposes its Docker Compose file, and its environment is synchronous. */
export interface FlociLocalProvider extends LocalProvider {
  composeConfig: (options?: LocalProviderComposeOptions) => string;
  environment: (options?: LocalAwsEnvironmentOptions) => LocalAwsEnvironment;
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
const defaultComposePath = ".voke/local/docker-compose.yml";

const composePathOf = ({ options }: LocalProviderLifecycleOptions): string =>
  options.compose ?? defaultComposePath;

const composeCommand = (
  options: LocalProviderLifecycleOptions,
  ...args: string[]
): string[][] => [["docker", "compose", "-f", composePathOf(options), ...args]];

/**
 * The Floci Local AWS Provider (Docker Compose): persistent local state and a small image.
 * Select it with `aws({ local: floci() })`.
 */
export const floci = (
  defaults: FlociLocalProviderOptions = {}
): FlociLocalProvider => {
  const composeConfig = (options: LocalProviderComposeOptions = {}): string => {
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
  };

  return {
    bindings: "guessed",
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
    composeConfig,
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
    files: (lifecycle) => {
      const { options } = lifecycle;

      return {
        [composePathOf(lifecycle)]: composeConfig({
          dataDirectory: options.data ?? ".voke/local/data",
          hostname: options.hostname,
          image: options.image,
          port: options.port === undefined ? undefined : Number(options.port),
          region: options.region,
        }),
      };
    },
    flags: {
      compose: `Docker Compose file. Default: ${defaultComposePath}`,
      data: "Floci data directory. Default: .voke/local/data",
      hostname: "Floci hostname",
      image: "Floci container image",
      port: "Floci port",
    },
    name: "floci",
    resetCommands: (options) => composeCommand(options, "down", "-v"),
    startCommands: (options) => composeCommand(options, "up", "-d"),
    stopCommands: (options) => composeCommand(options, "down"),
  };
};

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

  if (options.provider.name === "aws-emulator") {
    return options.localCommand === "bootstrap"
      ? `${base}\nMake sure the AWS Emulator is running with "voke local start" and the AWS CLI is installed, then retry "voke local bootstrap".`
      : `${base}\nMake sure Docker is installed and running, then retry "voke local ${options.localCommand}". Container logs: docker logs voke-aws-emulator-<port>`;
  }

  if (options.provider.name !== "floci") {
    return `${base}\nLocal provider: ${options.provider.name}. Check this provider's local command configuration.`;
  }

  if (options.localCommand === "bootstrap") {
    return `${base}\nFloci is an optional Local AWS Provider. Make sure Floci is running with "voke local start", then retry "voke local bootstrap". You can also pass another Local AWS Provider: aws({ local: ... })`;
  }

  return `${base}\nFloci is an optional Local AWS Provider. Make sure Docker Compose is installed and Docker is running, then retry "voke local ${options.localCommand}". You can also pass another Local AWS Provider: aws({ local: ... })`;
};
