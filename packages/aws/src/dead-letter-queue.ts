// The dead-letter queue every Event Source sends a failed event to: its logical id, its shape, the
// statement that lets a Function role send to it, and the option check every source shares.
// A dead-letter queue is not data-bearing (ADR 0019): it gets no retention policy.
import type {
  CloudFormationResource,
  CloudFormationValue,
} from "./cloudformation-template";
import type { AwsEventSourceContext, VokeIssue } from "./event-sources";

/** Fourteen days, the SQS maximum, so a message outlives the source queue's default four. */
export const deadLetterRetentionSeconds = 1_209_600;

/** Receives before SQS moves a message to the dead-letter queue; the AWS recommended minimum. */
export const sqsMaxReceiveCount = 5;

/** Stream retries before Lambda sends a batch's pointers to the dead-letter queue. */
export const streamMaxRetryAttemptsWithDeadLetterQueue = 10;

/** The owner is a queue's logical id for SQS, and the Function's logical id for every other source. */
export const deadLetterQueueLogicalId = (ownerLogicalId: string): string =>
  `${ownerLogicalId}DeadLetterQueue`;

export const deadLetterQueueArn = (logicalId: string): CloudFormationValue => ({
  "Fn::GetAtt": [logicalId, "Arn"],
});

export const deadLetterQueueResource = (
  options: { fifo?: boolean } = {}
): CloudFormationResource => ({
  Properties: {
    ...(options.fifo === true ? { FifoQueue: true } : {}),
    MessageRetentionPeriod: deadLetterRetentionSeconds,
  },
  Type: "AWS::SQS::Queue",
});

/** Lets Lambda, acting as the Function role, send a failure record to the queue. */
export const sendToDeadLetterQueueStatement = (
  logicalId: string
): CloudFormationValue => ({
  Action: ["sqs:SendMessage"],
  Effect: "Allow",
  Resource: deadLetterQueueArn(logicalId),
});

/** Every non-SQS Event Source stores `deadLetterQueue`; anything but `false` keeps it on. */
export const hasDeadLetterQueue = (
  context: Pick<AwsEventSourceContext, "eventSource">
): boolean => context.eventSource.properties.deadLetterQueue !== false;

export const deadLetterQueueOptionIssues = ({
  eventSource,
  eventSourceIndex,
  functionKey,
}: AwsEventSourceContext): VokeIssue[] => {
  const value = eventSource.properties.deadLetterQueue;

  if (value === undefined || typeof value === "boolean") {
    return [];
  }

  return [
    {
      message: `Function "${functionKey}" deadLetterQueue must be true or false, got ${JSON.stringify(value)}.`,
      path: `functions.${functionKey}.eventSources.${eventSourceIndex}.properties.deadLetterQueue`,
    },
  ];
};

/**
 * The queue and the asynchronous invocation settings that send an event the Function still fails
 * after Lambda's two retries to it. Lambda's retry count and maximum event age stay at their defaults.
 */
export const asyncFailureResources = (
  lambdaLogicalId: string
): Record<string, CloudFormationResource> => {
  const queueLogicalId = deadLetterQueueLogicalId(lambdaLogicalId);

  return {
    [queueLogicalId]: deadLetterQueueResource(),
    [`${lambdaLogicalId}EventInvokeConfig`]: {
      Properties: {
        DestinationConfig: {
          OnFailure: { Destination: deadLetterQueueArn(queueLogicalId) },
        },
        FunctionName: { Ref: lambdaLogicalId },
        Qualifier: "$LATEST",
      },
      Type: "AWS::Lambda::EventInvokeConfig",
    },
  };
};

/** The asynchronous-source pieces for one Event Source: none when it opted out. */
export const asyncFailureResourcesFor = (context: {
  eventSource: AwsEventSourceContext["eventSource"];
  lambdaLogicalId: string;
}): Record<string, CloudFormationResource> =>
  hasDeadLetterQueue(context)
    ? asyncFailureResources(context.lambdaLogicalId)
    : {};

/** The role statement for an asynchronous or stream source's Function-owned queue. */
export const functionDeadLetterQueueStatements = (context: {
  eventSource: AwsEventSourceContext["eventSource"];
  lambdaLogicalId: string;
}): CloudFormationValue[] =>
  hasDeadLetterQueue(context)
    ? [
        sendToDeadLetterQueueStatement(
          deadLetterQueueLogicalId(context.lambdaLogicalId)
        ),
      ]
    : [];
