export {
  dynamodbTable,
  eventBus,
  kinesisStream,
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
  KinesisStreamOptions,
  StackResourceDefinition,
  SynthesizeCloudFormationOptions,
} from "./cloudformation-synthesis";
