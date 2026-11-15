// The Event Sources the AWS Provider supports. Core carries each Event Source as an open record
// (`{ source, resource?, properties }`); everything AWS-specific about a source lives in its adapter.
// The table is internal: there is no public registration API yet.
import { VokeConfigError } from "voke";
import type { VokeModel, VokeModelEventSource, VokeModelError } from "voke";

import type { CloudFormationResource } from "./cloudformation-template";
import { eventBridgeEventSourceAdapter } from "./eventbridge";
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
  /** AWS Lambda event → the Function's Event Invocation input. */
  toInvocation(event: unknown): unknown;
  /** The handler's result → the value the Lambda handler returns. */
  toResponse(result: unknown): unknown;
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
}

const adapters: ReadonlyMap<string, AwsEventSourceAdapter> = new Map(
  [
    sqsEventSourceAdapter,
    snsEventSourceAdapter,
    eventBridgeEventSourceAdapter,
    scheduleEventSourceAdapter,
  ].map((adapter) => [adapter.source, adapter])
);

export const unsupportedEventSourceMessage = (
  functionKey: string,
  source: string
): string =>
  `Function "${functionKey}" uses Event Source "${source}", which the AWS Provider does not support.`;

export const findAwsEventSourceAdapter = (
  source: string
): AwsEventSourceAdapter | undefined => adapters.get(source);

/** The adapter for `source`; an unknown source is an error, never a skip. */
export const requireAwsEventSourceAdapter = (
  source: string,
  functionKey: string
): AwsEventSourceAdapter => {
  const adapter = adapters.get(source);

  if (adapter === undefined) {
    throw new VokeConfigError(
      unsupportedEventSourceMessage(functionKey, source)
    );
  }

  return adapter;
};
