// Run-time module: bundled into deployed Functions, so it must not import deploy-time code.
// The run-time half of each Event Source the AWS Provider supports: turning a Lambda event into the
// Function's Event Invocation input and its result into the Lambda response. Validation and
// synthesis live in the deploy-time adapters of `./event-sources`.
import { VokeConfigError } from "voke";

import { dynamodbStreamEventRuntimeAdapter } from "./dynamodb-stream";
import { eventBridgeEventRuntimeAdapter } from "./eventbridge";
import { kinesisEventRuntimeAdapter } from "./kinesis";
import { s3EventRuntimeAdapter } from "./s3";
import { scheduleEventRuntimeAdapter } from "./schedule";
import { snsEventRuntimeAdapter } from "./sns";
import { sqsEventRuntimeAdapter } from "./sqs";

export interface AwsEventSourceRuntimeAdapter {
  readonly source: string;
  /** AWS Lambda event → the Function's Event Invocation input. */
  toInvocation(event: unknown): unknown;
  /** The handler's result → the value the Lambda handler returns. */
  toResponse(result: unknown): unknown;
}

const runtimeAdapters: ReadonlyMap<string, AwsEventSourceRuntimeAdapter> =
  new Map(
    [
      sqsEventRuntimeAdapter,
      snsEventRuntimeAdapter,
      eventBridgeEventRuntimeAdapter,
      scheduleEventRuntimeAdapter,
      kinesisEventRuntimeAdapter,
      dynamodbStreamEventRuntimeAdapter,
      s3EventRuntimeAdapter,
    ].map((adapter) => [adapter.source, adapter])
  );

/** The Event Sources with a run-time adapter; the deploy-time table must list the same ones. */
export const awsEventSourceRuntimeSources = (): string[] => [
  ...runtimeAdapters.keys(),
];

export const unsupportedEventSourceMessage = (
  functionKey: string,
  source: string
): string =>
  `Function "${functionKey}" uses Event Source "${source}", which the AWS Provider does not support.`;

/** The run-time adapter for `source`; an unknown source is an error, never a skip. */
export const requireAwsEventSourceRuntimeAdapter = (
  source: string,
  functionKey: string
): AwsEventSourceRuntimeAdapter => {
  const adapter = runtimeAdapters.get(source);

  if (adapter === undefined) {
    throw new VokeConfigError(
      unsupportedEventSourceMessage(functionKey, source)
    );
  }

  return adapter;
};
