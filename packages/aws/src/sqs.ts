import { InvokeError, VokeConfigError } from "voke";
import type {
  EventFunctionDefinition,
  FunctionSynthesisConfig,
  InvokeContext,
  RuntimeVariableCatalog,
  StandardSchemaIssue,
  StandardSchemaV1,
} from "voke";

type StandardSchemaInput<TSchema> = TSchema extends {
  readonly "~standard": { readonly types: { input: infer TInput } };
}
  ? TInput
  : TSchema extends {
        readonly "~standard": {
          validate(value: infer TInput): unknown;
        };
      }
    ? TInput
    : never;

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
  error: InvokeError;
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
  SqsEventInvocationInput<StandardSchemaInput<TBodySchema>>,
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
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> extends SqsEventSourceOptions {
  readonly handler: (
    batch: StandardSchemaOutput<
      SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>
    >,
    context: InvokeContext<TVariables>
  ) => SqsBatchResult | Promise<SqsBatchResult>;
  readonly invalidMessageBody?: TInvalidMessageBody;
  readonly message: TMessageSchema;
  readonly name?: string;
  readonly queue?: string;
  readonly queues?: SqsQueueListInput;
  readonly synthesis?: FunctionSynthesisConfig;
  readonly variables?: TVariables;
}

export interface SqsEventHandlerOptions<TFunctions> {
  function: string;
  functions: TFunctions & {
    sendEvent: (name: never, event: never) => Promise<SqsBatchResult>;
  };
}

const createSqsBatchResult = (
  failures: SqsBatchItemFailure[] = []
): SqsBatchResultBuilder => {
  const result: SqsBatchResultBuilder = {
    batchItemFailures: failures,
    fail(message) {
      if (
        !this.batchItemFailures.some(
          (failure) => failure.itemIdentifier === message.id
        )
      ) {
        this.batchItemFailures.push({ itemIdentifier: message.id });
      }
    },
  };
  // Handlers return the builder itself; keep `fail` out of the serialized batch response.
  Object.defineProperty(result, "fail", {
    enumerable: false,
    value: result.fail,
  });

  return result;
};

const createSqsRecord = (
  message: SqsEventInvocationMessage<unknown>,
  index: number
): SqsRecord => {
  if (message.raw !== undefined) {
    return message.raw;
  }

  const body =
    typeof message.body === "string"
      ? message.body
      : JSON.stringify(message.body);
  const id = message.id ?? `msg_${index + 1}`;

  return {
    attributes: message.attributes ?? {},
    awsRegion: "local",
    body,
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:local:000000000000:local",
    md5OfBody: "",
    messageAttributes: message.messageAttributes ?? {},
    messageId: id,
    receiptHandle: `receipt-${id}`,
  };
};

const formatIssue = (issue: StandardSchemaIssue): string =>
  issue.path === undefined || issue.path.length === 0
    ? issue.message
    : `${issue.path.map(String).join(".")}: ${issue.message}`;

const invalidMessageError = (
  messageId: string,
  detail: string,
  cause?: unknown,
  issues?: readonly StandardSchemaIssue[]
): InvokeError =>
  new InvokeError(`Invalid SQS message body for ${messageId}: ${detail}`, {
    cause,
    code: "INVALID_PAYLOAD",
    functionName: messageId,
    issues,
  });

const parseMessageBody = async <TBodySchema extends AnyStandardSchema>(
  schema: TBodySchema,
  raw: SqsRecord
): Promise<StandardSchemaOutput<TBodySchema>> => {
  try {
    const result = await schema["~standard"].validate(
      JSON.parse(raw.body) as unknown
    );

    if (result.success) {
      return result.data as StandardSchemaOutput<TBodySchema>;
    }

    throw invalidMessageError(
      raw.messageId,
      result.issues.map(formatIssue).join("; "),
      undefined,
      result.issues
    );
  } catch (error) {
    if (error instanceof InvokeError) {
      throw error;
    }

    throw invalidMessageError(
      raw.messageId,
      error instanceof Error ? error.message : String(error),
      error
    );
  }
};

const parseSqsMessageBatch = async <
  TBodySchema extends AnyStandardSchema,
  TInvalidMessageBody extends SqsInvalidMessageBodyMode,
>(
  schema: SqsMessageBatchSchema<TBodySchema, TInvalidMessageBody>,
  input: SqsEventInvocationInput<StandardSchemaInput<TBodySchema>>
): Promise<StandardSchemaOutput<typeof schema>> => {
  const failures: SqsBatchItemFailure[] = [];
  const messages: (
    | SqsInvalidMessage
    | SqsValidMessage<StandardSchemaOutput<TBodySchema>>
  )[] = [];

  for (const [index, message] of input.messages.entries()) {
    const raw = createSqsRecord(message, index);
    let body: StandardSchemaOutput<TBodySchema>;

    try {
      body = await parseMessageBody(schema.body, raw);
    } catch (error) {
      failures.push({ itemIdentifier: raw.messageId });

      if (schema.invalidMessageBody === "include") {
        messages.push({
          attributes: raw.attributes,
          error: error as InvokeError,
          id: raw.messageId,
          messageAttributes: raw.messageAttributes,
          raw,
          rawBody: raw.body,
          valid: false,
        });
      }

      continue;
    }

    messages.push({
      attributes: raw.attributes,
      body,
      id: raw.messageId,
      messageAttributes: raw.messageAttributes,
      raw,
      valid: true,
    });
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
        value as SqsEventInvocationInput<StandardSchemaInput<TBodySchema>>
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
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
>(
  definition: SqsFunctionDefinitionInput<
    TMessageSchema,
    TInvalidMessageBody,
    TVariables
  >
): EventFunctionDefinition<
  string,
  SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>,
  TVariables
> => {
  if (definition.queue !== undefined && definition.queues !== undefined) {
    throw new VokeConfigError("Pass either queue or queues to sqs(), not both");
  }

  if (definition.queue === undefined && definition.queues === undefined) {
    throw new VokeConfigError("sqs() requires queue or queues");
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
    variables: definition.variables,
  }) as unknown as EventFunctionDefinition<
    string,
    SqsMessageBatchSchema<TMessageSchema, TInvalidMessageBody>,
    TVariables
  >;
};

const sqsInvocationFromAwsEvent = (
  event: SqsAwsEvent
): SqsEventInvocationInput => ({
  // Bodies stay raw strings; each message is JSON-parsed on its own so one malformed
  // body becomes a single batch item failure instead of failing the whole batch.
  messages: event.Records.map((record) => ({
    attributes: record.attributes,
    body: record.body,
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
