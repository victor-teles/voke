export { aws, type AwsProviderOptions } from "#provider";
export {
  createAuthorizers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
  type AuthorizerIdentitySource,
  type AuthorizerRegistry,
  type AuthorizerRegistryInput,
  type AuthorizerRequest,
  type AuthorizerResult,
  type HttpAuthorizerDefinition,
  type JwtAuthorizerDefinition,
  type JwtAuthorizerInput,
  type LambdaAuthorizerDefinition,
  type LambdaAuthorizerInput,
  type LambdaAuthorizerTarget,
  type RequestAuthorizerFunctionDefinition,
  type RequestAuthorizerFunctionInput,
  type RequestAuthorizerHandler,
} from "./authorizers";
export {
  createAwsClientConfig,
  createResourceBindingName,
  toEnvKey,
  type AwsClientConfig,
} from "./resources";
export {
  awsLambda,
  type AwsLambdaArchitecture,
  type AwsLambdaFunctionOptions,
  type AwsLambdaOptions,
  type AwsLambdaRuntime,
  type AwsLogRetentionDays,
} from "./lambda-settings";
export { parameter, secret } from "./runtime-variables";
export type { AwsDataResource, AwsRetainData } from "./data-retention";
export { awsPolicy, type AwsPolicyStatement } from "./plugin-records";
export type {
  AwsLambdaContext,
  AwsLambdaHttpApiV2Event,
  AwsLambdaHttpApiV2Result,
} from "./lambda";
export {
  createLambdaHandlers,
  type LambdaHandler,
  type LambdaHandlersOptions,
  type LambdaProjectModule,
} from "./lambda-handlers";
export {
  createAwsLambdaInvokeTransport,
  type AwsLambdaInvokeClient,
  type AwsLambdaInvokeTransportOptions,
} from "./lambda-invoke-transport";
export {
  sqs,
  createSqsEventHandler,
  type SqsBatchResult,
  type SqsAwsEvent,
  type SqsEventInvocationInput,
  type SqsEventSourceDefinition,
  type SqsEventSourceOptions,
  type SqsFunctionDefinitionInput,
  type SqsInvalidMessage,
  type SqsMessageBatch,
  type SqsMessageBatchIncludeInvalid,
  type SqsMessageBatchSchema,
  type SqsRecord,
  type SqsValidMessage,
} from "./sqs";
export {
  sns,
  type SnsAwsEvent,
  type SnsEventInvocationInput,
  type SnsEventSourceDefinition,
  type SnsFilterPolicy,
  type SnsFilterPolicyScope,
  type SnsFunctionDefinitionInput,
  type SnsMessage,
  type SnsMessageAttribute,
  type SnsMessageSchema,
  type SnsNotification,
  type SnsRecord,
} from "./sns";
export {
  eventBridge,
  type EventBridgeAwsEvent,
  type EventBridgeEvent,
  type EventBridgeEventInvocationInput,
  type EventBridgeEventSchema,
  type EventBridgeEventSourceDefinition,
  type EventBridgeFunctionDefinitionInput,
  type EventBridgePattern,
} from "./eventbridge";
export {
  schedule,
  type ScheduledEvent,
  type ScheduledEventSchema,
  type ScheduleEnvelope,
  type ScheduleEventInvocationInput,
  type ScheduleEventSourceDefinition,
  type ScheduleFunctionDefinitionInput,
} from "./schedule";
export {
  kinesis,
  type KinesisAwsEvent,
  type KinesisEventInvocationInput,
  type KinesisEventInvocationRecord,
  type KinesisEventSourceDefinition,
  type KinesisFunctionDefinitionInput,
  type KinesisInvalidRecord,
  type KinesisRecord,
  type KinesisRecordBatch,
  type KinesisRecordBatchIncludeInvalid,
  type KinesisRecordBatchSchema,
  type KinesisValidRecord,
} from "./kinesis";
export {
  dynamodbStream,
  type DynamodbStreamAwsEvent,
  type DynamodbStreamAwsRecord,
  type DynamodbStreamEventInvocationInput,
  type DynamodbStreamEventInvocationRecord,
  type DynamodbStreamEventName,
  type DynamodbStreamEventSourceDefinition,
  type DynamodbStreamFunctionDefinitionInput,
  type DynamodbStreamInvalidRecord,
  type DynamodbStreamRecordBatch,
  type DynamodbStreamRecordBatchIncludeInvalid,
  type DynamodbStreamRecordBatchSchema,
  type DynamodbStreamValidRecord,
  type DynamodbStreamViewType,
} from "./dynamodb-stream";
export {
  s3,
  type S3AwsEvent,
  type S3AwsEventDetail,
  type S3EventInvocationInput,
  type S3EventKind,
  type S3EventSourceDefinition,
  type S3FunctionDefinitionInput,
  type S3ObjectEvent,
  type S3ObjectEventSchema,
} from "./s3";
export {
  durable,
  type DurableContext,
  type DurableDuration,
  type DurableFunctionHandler,
  type DurableFunctionWithInputDefinitionInput,
  type DurableInvokeContext,
  type DurableZeroInputFunctionDefinitionInput,
} from "./durable";
export type {
  StreamBatchResult,
  StreamBatchResultBuilder,
  StreamEventSourceOptions,
  StreamInvalidRecordMode,
  StreamStartingPosition,
} from "./stream-batch";
