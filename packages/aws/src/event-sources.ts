// Deploy-time module: validation and synthesis of the Event Sources the AWS Provider supports. Core
// carries each Event Source as an open record (`{ source, resource?, properties }`); everything
// AWS-specific about a source lives in its adapters. The run-time half (`toInvocation`,
// `toResponse`) is in `./event-source-runtime`, so the Lambda Bundle never loads this table.
// The tables are internal: there is no public registration API yet.
import { VokeConfigError } from "voke";
import type { VokeModel, VokeModelEventSource, VokeModelError } from "voke";

import type {
  CloudFormationResource,
  CloudFormationValue,
} from "./cloudformation-template";
import { dynamodbStreamEventSourceAdapter } from "./dynamodb-stream";
import { unsupportedEventSourceMessage } from "./event-source-runtime";
import { eventBridgeEventSourceAdapter } from "./eventbridge";
import { kinesisEventSourceAdapter } from "./kinesis";
import { s3EventSourceAdapter } from "./s3";
import { scheduleEventSourceAdapter } from "./schedule";
import { snsEventSourceAdapter } from "./sns";
import { sqsEventSourceAdapter } from "./sqs";

export type VokeIssue = Parameters<typeof VokeModelError.validation>[0][number];

export interface AwsEventSourceContext {
  readonly eventSource: VokeModelEventSource;
  readonly eventSourceIndex: number;
  /** The Function Registry key of the Function the Event Source triggers. */
  readonly functionKey: string;
  readonly model: VokeModel;
}

export interface AwsEventSourceSynthesisContext extends AwsEventSourceContext {
  /** The logical id of the Function's `AWS::Lambda::Function` resource. */
  readonly lambdaLogicalId: string;
}

export interface AwsEventSourceAdapter {
  readonly source: string;
  /** Resource kind and property checks for one Event Source in the model. */
  validate(context: AwsEventSourceContext): VokeIssue[];
  /** CloudFormation resources for one Event Source, keyed by logical id. */
  synthesize(context: AwsEventSourceSynthesisContext): {
    resources: Record<string, CloudFormationResource>;
  };
  /**
   * Resources one stack needs once for all Event Sources of this type, such as a shared IAM role.
   * Synthesis calls it once, after every Function, with each Event Source of this type in Function
   * order; it is not called when the stack has none.
   */
  synthesizeStack?(contexts: readonly AwsEventSourceSynthesisContext[]): {
    resources: Record<string, CloudFormationResource>;
  };
  /**
   * IAM statements for the role of the Function the Event Source triggers, and no other role:
   * for example, reading the stream a mapping polls, or sending to the Function's dead-letter queue.
   */
  roleStatements?(
    context: AwsEventSourceSynthesisContext
  ): CloudFormationValue[];
  /**
   * The properties of the resource the Event Source references (`eventSource.resource`), given its
   * current properties: for example, turning on a bucket's EventBridge delivery. Return every
   * property, merging rather than replacing what is there. Synthesis calls it after `synthesize`
   * for each Event Source of this type, so it must give the same result when called again; it is
   * not called for a resources-only template.
   */
  resourceProperties?(
    context: AwsEventSourceContext,
    properties: Readonly<Record<string, CloudFormationValue>>
  ): Record<string, CloudFormationValue>;
}

// An array literal, not a Map built at load time, so a bundle that imports this module only for its
// types or a resource builder's dependencies keeps none of the adapters.
const adapters: readonly AwsEventSourceAdapter[] = [
  sqsEventSourceAdapter,
  snsEventSourceAdapter,
  eventBridgeEventSourceAdapter,
  scheduleEventSourceAdapter,
  kinesisEventSourceAdapter,
  dynamodbStreamEventSourceAdapter,
  s3EventSourceAdapter,
];

/** The Event Sources with a deploy-time adapter; the run-time table must list the same ones. */
export const awsEventSources = (): string[] =>
  adapters.map(({ source }) => source);

export const findAwsEventSourceAdapter = (
  source: string
): AwsEventSourceAdapter | undefined =>
  adapters.find((adapter) => adapter.source === source);

/** The adapter for `source`; an unknown source is an error, never a skip. */
export const requireAwsEventSourceAdapter = (
  source: string,
  functionKey: string
): AwsEventSourceAdapter => {
  const adapter = findAwsEventSourceAdapter(source);

  if (adapter === undefined) {
    throw new VokeConfigError(
      unsupportedEventSourceMessage(functionKey, source)
    );
  }

  return adapter;
};
