// CloudFormation pieces that several push Event Sources share: the check that an Event Source's
// `resource` names a declared resource of the right kind, and the Lambda permission a service needs
// to invoke the Function.
import { resourceProvider } from "./cloudformation-template";
import type {
  CloudFormationResource,
  CloudFormationValue,
} from "./cloudformation-template";
import type { AwsEventSourceContext, VokeIssue } from "./event-sources";

/** Lets `principal` invoke the Function, only from `sourceArn`. */
export const lambdaInvokePermissionResource = (
  lambdaLogicalId: string,
  principal: string,
  sourceArn: CloudFormationValue
): CloudFormationResource => ({
  Properties: {
    Action: "lambda:InvokeFunction",
    FunctionName: { Ref: lambdaLogicalId },
    Principal: principal,
    SourceArn: sourceArn,
  },
  Type: "AWS::Lambda::Permission",
});

export interface EventSourceResourceKind {
  /** The source's name in messages, for example "SNS". */
  readonly label: string;
  /** The CloudFormation type the resource must have, for example "AWS::SNS::Topic". */
  readonly cloudFormationType: string;
}

/** An issue when the Event Source's resource is missing or of another kind; otherwise `undefined`. */
export const eventSourceResourceKindIssue = (
  { eventSource, eventSourceIndex, functionKey, model }: AwsEventSourceContext,
  expected: EventSourceResourceKind
): VokeIssue | undefined => {
  const key = eventSource.resource ?? "";
  const resource = model.resources[key];
  const path = `functions.${functionKey}.eventSources.${eventSourceIndex}.resource`;

  if (resource === undefined) {
    return {
      message: `Function "${functionKey}" ${expected.label} event source references resource "${key}", but no matching resource is defined.`,
      path,
    };
  }

  const { cloudFormationType } = resourceProvider(resource);

  if (cloudFormationType === expected.cloudFormationType) {
    return undefined;
  }

  return {
    message: `Function "${functionKey}" ${expected.label} event source references resource "${key}", but it is an ${JSON.stringify(cloudFormationType)} resource instead of an "${expected.cloudFormationType}".`,
    path,
  };
};
