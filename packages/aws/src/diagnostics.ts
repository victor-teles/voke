import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { VokeDeployError } from "voke";
import type {
  DiagnosticResult,
  ProviderDiagnosticsCapability,
  VokeConfig,
} from "voke";

import { bootstrapStackName } from "./deploy";
import { createDeployAwsClients } from "./deploy-clients";
import type { StackDescription } from "./deploy-clients";
import type { LocalProvider } from "./local-provider";

export interface AwsDiagnosticsDependencies {
  describeStack: (
    name: string,
    region: string
  ) => Promise<StackDescription | undefined>;
  /** How long the credentials check waits for AWS. Default 10 seconds. */
  timeoutMs?: number;
  /** The path of an executable on PATH, or null. */
  which: (command: string) => Promise<string | null> | string | null;
}

const defaultTimeoutMs = 10_000;

class DiagnosticTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticTimeoutError";
  }
}

const timedOut = Symbol("timed out");

/** Resolves to `timedOut` after `ms`, or never settles once `signal` aborts. */
const timer = async (
  ms: number,
  signal: AbortSignal
): Promise<typeof timedOut> => {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    // Aborted because the call settled first; the race is already decided.
  }

  return timedOut;
};

// The AWS credential chain can wait a long time on an unreachable network or metadata endpoint.
const withTimeout = async <TResult>(
  promise: Promise<TResult>,
  ms: number,
  message: string
): Promise<TResult> => {
  const controller = new AbortController();

  try {
    const result = await Promise.race([promise, timer(ms, controller.signal)]);

    if (result === timedOut) {
      throw new DiagnosticTimeoutError(message);
    }

    return result;
  } finally {
    controller.abort();
  }
};

// aws() ships inside Lambda bundles, so this uses Node APIs rather than Bun.which.
const findExecutable = async (command: string): Promise<string | null> => {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const path = join(directory, `${command}${extension}`);

      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        // Not here; keep looking.
      }
    }
  }

  return null;
};

const defaultDependencies: AwsDiagnosticsDependencies = {
  describeStack: async (name, region) => {
    const clients = await createDeployAwsClients({ region });

    return await clients.describeStack(name);
  },
  which: findExecutable,
};

const credentialsCheck = "AWS credentials";

// arn:aws:cloudformation:<region>:<account>:stack/<name>/<id>
const accountOf = (stackArn: string | undefined): string | undefined =>
  stackArn?.split(":")[4] || undefined;

/** Only the account id and region are reported; nothing from the credentials themselves. */
const checkCredentials = async (
  config: VokeConfig,
  deps: AwsDiagnosticsDependencies
): Promise<DiagnosticResult> => {
  const { region } = config;

  try {
    const timeoutMs = deps.timeoutMs ?? defaultTimeoutMs;
    const bootstrap = await withTimeout(
      deps.describeStack(bootstrapStackName, region),
      timeoutMs,
      `AWS did not answer within ${timeoutMs / 1000}s in ${region}; check your network and credentials (AWS_PROFILE, SSO login)`
    );
    const account = accountOf(bootstrap?.id);

    return {
      check: credentialsCheck,
      detail:
        account === undefined
          ? `region ${region} (account shown after the first deploy)`
          : `account ${account}, region ${region}`,
      status: "ok",
    };
  } catch (error) {
    // The deploy client turns credential failures into one message that echoes nothing.
    if (
      error instanceof VokeDeployError ||
      error instanceof DiagnosticTimeoutError
    ) {
      return { check: credentialsCheck, detail: error.message, status: "fail" };
    }

    return {
      check: credentialsCheck,
      detail: `could not reach CloudFormation in ${region}: ${error instanceof Error ? error.message : String(error)}`,
      status: "fail",
    };
  }
};

const checkLocalTool = async (
  localProvider: LocalProvider,
  deps: AwsDiagnosticsDependencies
): Promise<DiagnosticResult | undefined> => {
  const [tool] =
    localProvider.startCommands({
      directory: "",
      options: {},
      region: "",
    })[0] ?? [];

  if (tool === undefined) {
    return undefined;
  }

  const path = await deps.which(tool);

  return path === null
    ? {
        check: tool,
        detail: "not found; install it to use voke local",
        status: "warn",
      }
    : { check: tool, detail: path, status: "ok" };
};

/** `voke doctor` rows for AWS: credentials for the configured region and the local tool. */
export const createAwsDiagnostics = (
  localProvider: LocalProvider,
  deps: AwsDiagnosticsDependencies = defaultDependencies
): ProviderDiagnosticsCapability => ({
  run: async ({ config }) => {
    const local = await checkLocalTool(localProvider, deps);

    return [
      await checkCredentials(config, deps),
      ...(local === undefined ? [] : [local]),
    ];
  },
});
