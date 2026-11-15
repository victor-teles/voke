import { VokeConfigError, VokeModelError } from "voke";
import type {
  VokeModel,
  VokeModelFunction,
  VokeModelProviderExtensionRecord,
} from "voke";

type VokeIssue = Parameters<typeof VokeModelError.validation>[0][number];

export type AwsLambdaRuntime = "nodejs22.x" | "nodejs24.x";
export type AwsLambdaArchitecture = "arm64" | "x86_64";

// The values CloudWatch Logs accepts for RetentionInDays (AWS::Logs::LogGroup).
const logRetentionDays = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
] as const;

export type AwsLogRetentionDays = (typeof logRetentionDays)[number];

export interface AwsLambdaOptions {
  /** Default `"arm64"`. */
  architecture?: AwsLambdaArchitecture;
  /** How long each Function's log group keeps logs. Default 14. */
  logRetentionDays?: AwsLogRetentionDays;
  /** Default `"nodejs22.x"`. */
  runtime?: AwsLambdaRuntime;
}

/** `aws({ lambda })` options with every default applied. */
export type AwsLambdaSettings = Required<AwsLambdaOptions>;

export const defaultAwsLambdaSettings: AwsLambdaSettings = {
  architecture: "arm64",
  logRetentionDays: 14,
  runtime: "nodejs22.x",
};

/** The per-Function override that `awsLambda()` stores in `synthesis.provider.aws`. */
export interface AwsLambdaFunctionOptions {
  architecture?: AwsLambdaArchitecture;
  runtime?: AwsLambdaRuntime;
}

const lambdaFunctionRecordType = "lambda.function";
const runtimes: readonly AwsLambdaRuntime[] = ["nodejs22.x", "nodejs24.x"];
const architectures: readonly AwsLambdaArchitecture[] = ["arm64", "x86_64"];

// Lambda quotas for memory (MB) and timeout (seconds), and the HTTP API integration timeout.
const minMemory = 128;
const maxMemory = 10_240;
const minTimeout = 1;
const maxTimeout = 900;
const httpApiIntegrationTimeout = 30;
// AWS recommends a queue visibility timeout of at least six times the Function timeout.
const visibilityTimeoutFactor = 6;

/**
 * Per-Function Lambda settings, for `synthesis.provider`:
 * `synthesis: { provider: awsLambda({ architecture: "x86_64" }) }`.
 */
export const awsLambda = (
  options: AwsLambdaFunctionOptions
): Record<"aws", VokeModelProviderExtensionRecord> => ({
  aws: { properties: { ...options }, type: lambdaFunctionRecordType },
});

const oneOfIssue = (
  allowed: readonly string[],
  value: unknown,
  path: string
): VokeIssue | undefined =>
  typeof value === "string" && allowed.includes(value)
    ? undefined
    : {
        message: `expected one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}; received ${JSON.stringify(value)}`,
        path,
      };

const retentionIssue = (value: unknown): VokeIssue | undefined => {
  if ((logRetentionDays as readonly unknown[]).includes(value)) {
    return undefined;
  }

  const target = typeof value === "number" ? value : 14;
  const below = logRetentionDays.findLast((days) => days < target) ?? 1;
  const above = logRetentionDays.find((days) => days > target) ?? 3653;

  return {
    message: `expected a CloudWatch Logs retention period such as ${below} or ${above}; received ${JSON.stringify(value)}`,
    path: "aws.lambda.logRetentionDays",
  };
};

/** Validates `aws({ lambda })` and applies the defaults. */
export const defineAwsLambdaSettings = (
  options: AwsLambdaOptions = {}
): AwsLambdaSettings => {
  const settings = { ...defaultAwsLambdaSettings, ...options };
  const issues = [
    oneOfIssue(runtimes, settings.runtime, "aws.lambda.runtime"),
    oneOfIssue(architectures, settings.architecture, "aws.lambda.architecture"),
    retentionIssue(settings.logRetentionDays),
  ].filter((issue) => issue !== undefined);

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return settings;
};

const functionRecordIssues = (
  name: string,
  record: VokeModelProviderExtensionRecord
): VokeIssue[] => {
  const path = `functions.${name}.synthesis.provider.aws`;

  if (record.type !== lambdaFunctionRecordType) {
    return [
      {
        message: `expected "${lambdaFunctionRecordType}" (use awsLambda() from "@voke/aws"); received ${JSON.stringify(record.type)}`,
        path: `${path}.type`,
      },
    ];
  }

  const { architecture, runtime } = record.properties;

  return [
    runtime === undefined
      ? undefined
      : oneOfIssue(runtimes, runtime, `${path}.properties.runtime`),
    architecture === undefined
      ? undefined
      : oneOfIssue(
          architectures,
          architecture,
          `${path}.properties.architecture`
        ),
  ].filter((issue) => issue !== undefined);
};

const functionLimitIssues = (
  name: string,
  definition: VokeModelFunction
): VokeIssue[] => {
  const path = `functions.${name}.synthesis`;
  const issues: VokeIssue[] = [];

  if (definition.memory < minMemory || definition.memory > maxMemory) {
    issues.push({
      message: `Function "${name}" memory ${definition.memory} MB is outside the Lambda range ${minMemory}-${maxMemory} MB`,
      path: `${path}.memory`,
    });
  }

  if (definition.timeout < minTimeout || definition.timeout > maxTimeout) {
    issues.push({
      message: `Function "${name}" timeout ${definition.timeout}s is outside the Lambda range ${minTimeout}-${maxTimeout}s`,
      path: `${path}.timeout`,
    });
  } else if (
    definition.routes.length > 0 &&
    definition.timeout > httpApiIntegrationTimeout
  ) {
    issues.push({
      message: `Function "${name}" timeout ${definition.timeout}s exceeds the ${httpApiIntegrationTimeout}s API Gateway HTTP API integration limit; lower synthesis.timeout to ${httpApiIntegrationTimeout} or less, or move the work to an SQS Function`,
      path: `${path}.timeout`,
    });
  }

  return issues;
};

/** The explicit `sqsQueue({ visibilityTimeoutSeconds })`, if any. */
export const explicitVisibilityTimeout = (
  model: VokeModel,
  queue: string
): number | undefined => {
  const value = model.resources[queue]?.properties.VisibilityTimeout;

  return typeof value === "number" ? value : undefined;
};

// Only SQS Event Sources read from a queue; the queue is their resource key.
const sqsQueueKeys = (definition: VokeModelFunction): string[] =>
  definition.eventSources
    .filter((eventSource) => eventSource.type === "sqs")
    .map((eventSource) => eventSource.resource ?? "");

const visibilityTimeoutIssues = (model: VokeModel): VokeIssue[] =>
  Object.entries(model.functions).flatMap(([name, definition]) =>
    sqsQueueKeys(definition).flatMap((queue) => {
      const visibility = explicitVisibilityTimeout(model, queue);

      return visibility === undefined || visibility >= definition.timeout
        ? []
        : [
            {
              message: `queue visibility timeout ${visibility}s is lower than Function "${name}" timeout ${definition.timeout}s; set sqsQueue({ visibilityTimeoutSeconds }) to at least ${definition.timeout}, or leave it unset so Voke derives it`,
              path: `resources.${queue}.properties.VisibilityTimeout`,
            },
          ];
    })
  );

/** Lambda, HTTP API and SQS limits the neutral model cannot know about. */
export const validateAwsLambdaModel = (model: VokeModel): void => {
  const issues = [
    ...Object.entries(model.functions).flatMap(([name, definition]) => [
      ...functionLimitIssues(name, definition),
      ...(definition.provider?.aws === undefined
        ? []
        : functionRecordIssues(name, definition.provider.aws)),
    ]),
    ...visibilityTimeoutIssues(model),
  ];

  if (issues.length > 0) {
    throw VokeModelError.validation(issues);
  }
};

/** Function record → `aws({ lambda })` option → default. The model is validated first. */
export const resolveFunctionLambdaSettings = (
  definition: VokeModelFunction,
  settings: AwsLambdaSettings
): { architecture: AwsLambdaArchitecture; runtime: AwsLambdaRuntime } => {
  const properties = definition.provider?.aws?.properties ?? {};

  return {
    architecture:
      (properties.architecture as AwsLambdaArchitecture | undefined) ??
      settings.architecture,
    runtime:
      (properties.runtime as AwsLambdaRuntime | undefined) ?? settings.runtime,
  };
};

/**
 * The visibility timeout Voke derives for a queue with no explicit value: six times the largest
 * consumer timeout plus its batching window. `undefined` when no Function consumes the queue.
 */
export const derivedVisibilityTimeout = (
  model: VokeModel,
  queue: string
): number | undefined => {
  const needed = Object.values(model.functions).flatMap((definition) =>
    definition.eventSources
      .filter(
        (eventSource) =>
          eventSource.type === "sqs" && eventSource.resource === queue
      )
      .map((eventSource) => {
        const window = eventSource.properties.maxBatchingWindowSeconds;

        return (
          visibilityTimeoutFactor * definition.timeout +
          (typeof window === "number" ? window : 0)
        );
      })
  );

  return needed.length === 0 ? undefined : Math.max(...needed);
};
