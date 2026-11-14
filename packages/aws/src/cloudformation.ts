export {
  dynamodbTable,
  eventBus,
  s3Bucket,
  secret,
  snsTopic,
  sqsQueue,
  ssmParameter,
  synthesizeCloudFormation,
} from "./cloudformation-synthesis";
export type {
  CloudFormationOutput,
  CloudFormationResource,
  CloudFormationTemplate,
  CloudFormationValue,
  StackResourceDefinition,
  SynthesizeCloudFormationOptions,
} from "./cloudformation-synthesis";
