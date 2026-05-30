import type {
  EventFunctionDefinition,
  StandardSchemaIssue,
  StandardSchemaV1,
} from "voke";

type StandardSchemaOutput<TSchema> =
  TSchema extends StandardSchemaV1<unknown, infer TOutput> ? TOutput : never;

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

export interface SqsEventSourceOptions {
  batchSize?: number;
  enabled?: boolean;
  maxBatchingWindowSeconds?: number;
}

export interface SqsEventSourceDefinition {
  readonly options: SqsEventSourceOptions;
  readonly queue: string;
  readonly source: "sqs";
}

export interface SqsMessageAttribute {
  binaryListValues?: string[];
  binaryValue?: string;
  dataType: string;
  stringListValues?: string[];
  stringValue?: string;
}

export interface SqsRecord {
  attributes: Record<string, string>;
  awsRegion: string;
  body: string;
  eventSource: "aws:sqs";
  eventSourceARN: string;
  md5OfBody: string;
  messageAttributes: Record<string, SqsMessageAttribute>;
  messageId: string;
  receiptHandle: string;
}

export interface SqsAwsEvent {
  Records: SqsRecord[];
}

export interface SqsBatchItemFailure {
  itemIdentifier: string;
}

export interface SqsBatchResult {
  batchItemFailures: SqsBatchItemFailure[];
}

export interface SqsValidMessage<TBody> {
  attributes: Record<string, string>;
  body: TBody;
  id: string;
  messageAttributes: Record<string, SqsMessageAttribute>;
  raw: SqsRecord;
  valid: true;
}

export interface SqsInvalidMessage {
  attributes: Record<string, string>;
  error: Error;
  id: string;
  messageAttributes: Record<string, SqsMessageAttribute>;
  raw: SqsRecord;
  rawBody: string;
  valid: false;
}

export interface SqsBatchResultBuilder extends SqsBatchResult {
  fail(message: Pick<SqsInvalidMessage | SqsValidMessage<unknown>, "id">): void;
}

export interface SqsMessageBatch<TMessage> {
  batchResult(): SqsBatchResultBuilder;
  messages: SqsValidMessage<TMessage>[];
  ok(): SqsBatchResult;
  source: "sqs";
}

export interface SqsMessageBatchIncludeInvalid<TMessage> {
  batchResult(): SqsBatchResultBuilder;
  messages: (SqsInvalidMessage | SqsValidMessage<TMessage>)[];
  ok(): SqsBatchResult;
  source: "sqs";
}

export type SqsInvalidMessageBodyMode = "fail" | "include";

export interface SqsEventInvocationMessage<TBody> {
  attributes?: Record<string, string>;
  body: TBody;
  id?: string;
  messageAttributes?: Record<string, SqsMessageAttribute>;
  raw?: SqsRecord;
}

export interface SqsEventInvocationInput<TBody = unknown> {
  messages: SqsEventInvocationMessage<TBody>[];
  source?: "sqs";
}

export interface SqsMessageBatchOptions<
  TInvalidMessageBody extends SqsInvalidMessageBodyMode =
    SqsInvalidMessageBodyMode,
> {
  invalidMessageBody?: TInvalidMessageBody;
}

export interface SqsMessageBatchSchema<
  TBodySchema extends AnyStandardSchema = AnyStandardSchema,
  TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
> extends StandardSchemaV1<
  SqsEventInvocationInput,
  TInvalidMessageBody extends "include"
    ? SqsMessageBatchIncludeInvalid<StandardSchemaOutput<TBodySchema>>
    : SqsMessageBatch<StandardSchemaOutput<TBodySchema>>
> {
  readonly body: TBodySchema;
  readonly invalidMessageBody: TInvalidMessageBody;
  readonly source: "sqs";
}

type SqsQueueInput =
  | string
  | ({ readonly queue: string } & SqsEventSourceOptions);

type SqsQueueListInput = SqsQueueInput | readonly SqsQueueInput[];

export interface SqsFunctionDefinitionInput<
  TMessageSchema extends AnyStandardSchema,
  TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
> extends SqsEventSourceOptions {
  readonly handler: (
    batch: StandardSchemaOutput<
      SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>
    >,
    context: { functionName: string; trace: Record<string, unknown> }
  ) => SqsBatchResult | Promise<SqsBatchResult>;
  readonly invalidMessageBody?: TInvalidMessageBody;
  readonly message: TMessageSchema;
  readonly name?: string;
  readonly queue?: string;
  readonly queues?: SqsQueueListInput;
  readonly synthesis?: {
    entrypoint?: string;
    environment?: Record<string, string>;
    handler?: string;
    runtime?: "nodejs22.x" | "nodejs24.x";
  };
}

export interface SqsEventHandlerOptions<TFunctions> {
  function: string;
  functions: TFunctions & {
    sendEvent: (name: never, event: never) => Promise<SqsBatchResult>;
  };
}

const createSqsBatchResult = (
  initialFailures: SqsBatchItemFailure[] = []
): SqsBatchResultBuilder => {
  const failures = [...initialFailures];

  return {
    batchItemFailures: failures,
    fail: (message) => {
      failures.push({ itemIdentifier: message.id });
    },
  };
};

const issueMessage = (issues: readonly StandardSchemaIssue[]): string =>
  issues.map((issue) => issue.message).join("; ");

const parseMessageBody = async <TBodySchema extends AnyStandardSchema>(
  schema: TBodySchema,
  body: unknown
): Promise<StandardSchemaOutput<TBodySchema>> => {
  const result = await schema["~standard"].validate(body);

  if (!result.success) {
    throw new Error(issueMessage(result.issues));
  }

  return result.data as StandardSchemaOutput<TBodySchema>;
};

const parseSqsMessageBatch = async <
  TBodySchema extends AnyStandardSchema,
  TInvalidMessageBody extends SqsInvalidMessageBodyMode,
>(
  schema: SqsMessageBatchSchema<TBodySchema, TInvalidMessageBody>,
  value: SqsEventInvocationInput
): Promise<StandardSchemaOutput<typeof schema>> => {
  const messages: (SqsInvalidMessage | SqsValidMessage<unknown>)[] = [];
  const failures: SqsBatchItemFailure[] = [];

  for (const [index, message] of value.messages.entries()) {
    const raw =
      message.raw ??
      ({
        attributes: message.attributes ?? {},
        awsRegion: "us-east-1",
        body: JSON.stringify(message.body),
        eventSource: "aws:sqs",
        eventSourceARN: "",
        md5OfBody: "",
        messageAttributes: message.messageAttributes ?? {},
        messageId: message.id ?? `${index}`,
        receiptHandle: "",
      } satisfies SqsRecord);

    try {
      messages.push({
        attributes: raw.attributes,
        body: await parseMessageBody(schema.body, message.body),
        id: raw.messageId,
        messageAttributes: raw.messageAttributes,
        raw,
        valid: true,
      });
    } catch (error) {
      failures.push({ itemIdentifier: raw.messageId });

      if (schema.invalidMessageBody === "include") {
        messages.push({
          attributes: raw.attributes,
          error: error instanceof Error ? error : new Error(String(error)),
          id: raw.messageId,
          messageAttributes: raw.messageAttributes,
          raw,
          rawBody: raw.body,
          valid: false,
        });
      }
    }
  }

  return {
    batchResult: () => createSqsBatchResult([...failures]),
    messages,
    ok: () => ({ batchItemFailures: [...failures] }),
    source: "sqs",
  } as StandardSchemaOutput<typeof schema>;
};

export const sqsEventSource = (
  queue: string,
  options: SqsEventSourceOptions = {}
): SqsEventSourceDefinition => ({
  options,
  queue,
  source: "sqs",
});

export const sqsMessageBatch = <
  const TBodySchema extends AnyStandardSchema,
  const TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
>(
  body: TBodySchema,
  options: SqsMessageBatchOptions<TInvalidMessageBody> = {}
): SqsMessageBatchSchema<TBodySchema, TInvalidMessageBody> => ({
  body,
  invalidMessageBody:
    options.invalidMessageBody ?? ("fail" as TInvalidMessageBody),
  source: "sqs",
  "~standard": {
    validate: async (value) => ({
      data: await parseSqsMessageBatch(
        {
          body,
          invalidMessageBody: options.invalidMessageBody ?? "fail",
          source: "sqs",
        } as SqsMessageBatchSchema<TBodySchema, TInvalidMessageBody>,
        value as SqsEventInvocationInput
      ),
      success: true,
    }),
    vendor: "voke",
    version: 1,
  },
});

const queueInputs = (queues: SqsQueueListInput): readonly SqsQueueInput[] =>
  Array.isArray(queues) ? queues : [queues as SqsQueueInput];

const eventSourceFromQueueInput = (
  queue: SqsQueueInput,
  options: SqsEventSourceOptions
): SqsEventSourceDefinition => {
  if (typeof queue === "string") {
    return sqsEventSource(queue, options);
  }

  const { queue: queueName, ...queueOptions } = queue;

  return sqsEventSource(queueName, {
    ...options,
    ...queueOptions,
  });
};

export const sqs = <
  const TMessageSchema extends AnyStandardSchema,
  const TInvalidMessageBody extends SqsInvalidMessageBodyMode = "fail",
>(
  definition: SqsFunctionDefinitionInput<TMessageSchema, TInvalidMessageBody>
): EventFunctionDefinition<
  string,
  SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>
> => {
  if (definition.queue !== undefined && definition.queues !== undefined) {
    throw new Error("Pass either queue or queues to sqs(), not both");
  }

  if (definition.queue === undefined && definition.queues === undefined) {
    throw new Error("sqs() requires queue or queues");
  }

  const options = {
    batchSize: definition.batchSize ?? 10,
    enabled: definition.enabled,
    maxBatchingWindowSeconds: definition.maxBatchingWindowSeconds,
  };
  const queues =
    definition.queue === undefined
      ? queueInputs(definition.queues as SqsQueueListInput)
      : [definition.queue];

  return Object.freeze({
    events: Object.freeze(
      queues.map((queue) => eventSourceFromQueueInput(queue, options))
    ),
    handler: definition.handler,
    input: sqsMessageBatch(definition.message, {
      invalidMessageBody:
        definition.invalidMessageBody ?? ("fail" as TInvalidMessageBody),
    }),
    key: "",
    kind: "event",
    name: definition.name,
    routes: [],
    synthesis: definition.synthesis,
  }) as unknown as EventFunctionDefinition<
    string,
    SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>
  >;
};

const sqsInvocationFromAwsEvent = (
  event: SqsAwsEvent
): SqsEventInvocationInput => ({
  messages: event.Records.map((record) => ({
    attributes: record.attributes,
    body: JSON.parse(record.body) as unknown,
    id: record.messageId,
    messageAttributes: record.messageAttributes,
    raw: record,
  })),
  source: "sqs",
});

export const createSqsEventHandler =
  <const TFunctions>(options: SqsEventHandlerOptions<TFunctions>) =>
  async (event: SqsAwsEvent): Promise<SqsBatchResult> =>
    await options.functions.sendEvent(
      options.function as never,
      sqsInvocationFromAwsEvent(event) as never
    );
