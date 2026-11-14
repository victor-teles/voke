import { access, readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { LocalProviderError } from "./local-provider";
import type {
  LocalAwsEnvironment,
  LocalProvider,
  LocalProviderLifecycleOptions,
} from "./local-provider";

export interface AwsEmulatorOptions {
  /** Host and container port. Default 9297. */
  port?: number;
  /** A pinned emulator release, such as "1.0.367". Default: the LTS latest package. */
  version?: string;
  /** Send usage telemetry to AWS. Default false. */
  telemetry?: boolean;
  /** Container memory limit. Default "2g", as AWS recommends. */
  memory?: string;
  /** Image tag. Default `voke-aws-emulator:<version or latest>-<arch>`. */
  image?: string;
}

/** Seams for tests: the clock, HTTP and the file system. */
export interface AwsEmulatorDependencies {
  arch: string;
  exists: (path: string) => Promise<boolean>;
  fetch: (url: string, init: { tls: { ca: string } }) => Promise<Response>;
  now: () => number;
  platform: string;
  readFile: (path: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  user: () => string | undefined;
}

const defaultPort = 9297;
const defaultRegion = "us-east-1";
const readyTimeoutMs = 30_000;
const readyPollMs = 250;
const packageBaseUrl =
  "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS";
// Never forwarded to the emulator's clients: the emulator generates its own credentials.
const realCredentialVariables = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
] as const;

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const defaultDependencies: AwsEmulatorDependencies = {
  arch: process.arch,
  exists,
  fetch: (url, init) => fetch(url, init as RequestInit),
  now: () => Date.now(),
  platform: process.platform,
  readFile: (path) => readFile(path, "utf-8"),
  sleep: (ms) =>
    // oxlint-disable-next-line promise/avoid-new -- a plain delay between health polls
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  user: () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();

    return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
  },
};

const rpmArch = (arch: string): string =>
  arch === "arm64" ? "aarch64" : "x86_64";

const dockerfile = (version: string | undefined, arch: string): string => {
  const rpm =
    version === undefined
      ? `latest/aws-emulator-${rpmArch(arch)}.rpm`
      : `${version}/aws-emulator-${version}-1-${rpmArch(arch)}.rpm`;

  return `FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ADD ${packageBaseUrl}/${rpm} /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \\
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE ${defaultPort}
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
`;
};

/**
 * The official AWS Emulator as a Local AWS Provider, run in Docker. It provisions the project's
 * resources through its CloudFormation; Function code keeps running in the local Gateway, because
 * the emulator's Lambda runtime cannot load a Voke bundle. Its state lives in memory and under
 * `.voke/local/aws-emulator/<port>/`. Voke passes the generated credentials file by path and never
 * reads it.
 */
export const awsEmulator = (
  options: AwsEmulatorOptions = {},
  dependencies: Partial<AwsEmulatorDependencies> = {}
): LocalProvider => {
  const deps = { ...defaultDependencies, ...dependencies };
  const port = options.port ?? defaultPort;
  const endpoint = `https://127.0.0.1:${port}`;
  const container = `voke-aws-emulator-${port}`;
  const image =
    options.image ??
    `voke-aws-emulator:${options.version ?? "latest"}-${rpmArch(deps.arch)}`;
  const memory = options.memory ?? "2g";
  const portDirectory = (directory: string): string =>
    join(directory, String(port));

  const runCommand = ({ directory }: LocalProviderLifecycleOptions) => {
    const user = deps.platform === "linux" ? deps.user() : undefined;

    return [
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      container,
      `--memory=${memory}`,
      `--memory-swap=${memory}`,
      "-p",
      `127.0.0.1:${port}:${port}`,
      "-v",
      `${directory}:/home/emulator/.aws/emulator`,
      ...(user === undefined ? [] : ["--user", user]),
      image,
      "-p",
      String(port),
      "-t",
      options.telemetry === true ? "on" : "off",
    ];
  };
  const stopCommand = ["docker", "stop", container];

  return {
    bindings: "outputs",
    // Resources only: no IAM, so no capabilities flag. A repeated bootstrap with no changes succeeds.
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
          "--region",
          region,
          "--no-fail-on-empty-changeset",
        ],
      ],
      environment,
    }),
    defaults: {
      accountId: "000000000000",
      endpoint,
      region: defaultRegion,
    },
    environment: async (environmentOptions = {}) => {
      const directory =
        environmentOptions.directory ??
        resolvePath(".voke", "local", "aws-emulator");
      const files = portDirectory(directory);
      const region = environmentOptions.region ?? defaultRegion;
      const url = environmentOptions.endpoint ?? endpoint;

      if (!(await deps.exists(files))) {
        throw new LocalProviderError({
          cause: undefined,
          command: [],
          message: `AWS Emulator is not running (no state in ${files}). Start it with: voke local start`,
          provider: "aws-emulator",
        });
      }

      const caFile = join(files, "ca.pem");
      const environment: LocalAwsEnvironment = {
        AWS_CA_BUNDLE: caFile,
        AWS_CONFIG_FILE: join(directory, "config"),
        AWS_DEFAULT_REGION: region,
        AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_ENDPOINT_URL: url,
        AWS_REGION: region,
        AWS_SHARED_CREDENTIALS_FILE: join(files, "emulator_credentials"),
        NODE_EXTRA_CA_CERTS: caFile,
        VOKE_AWS_ENDPOINT_URL: url,
        VOKE_INVOKE_RUNTIME: "local",
        VOKE_LOCAL_PROVIDER: "aws-emulator",
      };

      return environment;
    },
    // The emulator writes a config file with a container path, so Voke writes its own.
    files: ({ directory, region }) => ({
      [join(directory, "Dockerfile")]: dockerfile(options.version, deps.arch),
      [join(directory, "config")]: `[default]\nregion = ${region}\n`,
    }),
    flags: {
      rebuild: "Rebuild the AWS Emulator image even if it exists",
    },
    name: "aws-emulator",
    prepareStart: async ({ directory, options: flags }, run) => {
      const rebuild = flags.rebuild !== undefined && flags.rebuild !== "false";

      if (!rebuild) {
        try {
          await run([
            "docker",
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            image,
          ]);
          return;
        } catch {
          // Not built yet.
        }
      }

      await run(["docker", "build", "-q", "-t", image, directory]);
    },
    resetCommands: (lifecycle) => [stopCommand, runCommand(lifecycle)],
    startCommands: (lifecycle) => [runCommand(lifecycle)],
    stopCommands: () => [stopCommand],
    unsetEnvironment: realCredentialVariables,
    waitUntilReady: async ({ directory }) => {
      const caFile = join(portDirectory(directory), "ca.pem");
      const deadline = deps.now() + readyTimeoutMs;

      while (deps.now() < deadline) {
        if (await deps.exists(caFile)) {
          try {
            const response = await deps.fetch(`${endpoint}/__admin/health`, {
              tls: { ca: await deps.readFile(caFile) },
            });

            if (response.ok) {
              return;
            }
          } catch {
            // Still starting.
          }
        }

        await deps.sleep(readyPollMs);
      }

      throw new LocalProviderError({
        cause: undefined,
        command: ["docker", "run", image],
        message: `AWS Emulator did not become ready on ${endpoint} within ${readyTimeoutMs / 1000}s. Check: docker logs ${container}`,
        provider: "aws-emulator",
      });
    },
  };
};
