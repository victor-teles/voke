import { InvokeError, VokeConfigError, VokeModelError } from "voke";
import type {
  EventFunctionDefinition,
  EventSourceDefinition,
  FunctionSynthesisConfig,
  InvokeContext,
  RuntimeVariableCatalog,
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
  VokeModelRecord,
} from "voke";

import { toLogicalId } from "./cloudformation-template";
import {
  asyncFailureResourcesFor,
  deadLetterQueueOptionIssues,
  functionDeadLetterQueueStatements,
} from "./dead-letter-queue";
import { parseJsonEventPayload } from "./event-payload";
import {
  eventSourceResourceKindIssue,
  lambdaInvokePermissionResource,
} from "./event-source-resources";
import type { AwsEventSourceRuntimeAdapter } from "./event-source-runtime";
import type {
  AwsEventSourceAdapter,
  AwsEventSourceContext,
  VokeIssue,
} from "./event-sources";

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

/** Where SNS applies a filter policy: the message attributes (the SNS default) or the JSON body. */
export type SnsFilterPolicyScope = "MessageAttributes" | "MessageBody";

/** An SNS subscription filter policy, copied to the subscription untouched. */
export type SnsFilterPolicy = VokeModelRecord;

/** An SNS Event Source as `sns()` stores it: the topic resource key plus the filter settings that were set. */
export interface SnsEventSourceDefinition extends EventSourceDefinition {
  readonly properties: {
    readonly deadLetterQueue: boolean;
    readonly filterPolicy?: SnsFilterPolicy;
    readonly filterPolicyScope?: SnsFilterPolicyScope;
  };
  readonly resource: string;
  readonly source: "sns";
}

/** One SNS message attribute, as the sender set it. */
export interface SnsMessageAttribute {
  type: string;
  value: string;
}

/** The `Sns` object of an SNS record, as Lambda delivers it. */
export interface SnsNotification {
  Message: string;
  MessageAttributes: Record<string, { Type: string; Value: string }>;
  MessageId: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertUrl?: string;
  Subject?: string | null;
  Timestamp: string;
  TopicArn: string;
  Type: string;
  UnsubscribeUrl?: string;
}

/** One record of the SNS event Lambda receives. */
export interface SnsRecord {
  EventSource: "aws:sns";
  EventSubscriptionArn: string;
  EventVersion: string;
  Sns: SnsNotification;
}

/** The SNS event Lambda receives. SNS delivers one record per invocation. */
export interface SnsAwsEvent {
  Records: SnsRecord[];
}

/** What an `sns()` handler receives: one message with its parsed, validated body. */
export interface SnsMessage<TBody> {
  attributes: Record<string, SnsMessageAttribute>;
  body: TBody;
  id: string;
  /** The untouched SNS record. */
  raw: SnsRecord;
  subject?: string;
  timestamp: string;
  topicArn: string;
}

/**
 * The input of `functions.sendEvent` for an `sns()` Function. Only `message` is required; Voke fills
 * in the SNS metadata. An object `message` is serialized to JSON; a string is used as it is.
 */
export interface SnsEventInvocationInput<TBody = unknown> {
  attributes?: Record<string, SnsMessageAttribute>;
  id?: string;
  message: TBody;
  /** The SNS record to read instead; the deployed handler passes the record it received. */
  raw?: SnsRecord;
  subject?: string;
}

export interface SnsMessageSchema<
  TBodySchema extends AnyStandardSchema = AnyStandardSchema,
> extends StandardSchemaV1<
  SnsEventInvocationInput<StandardSchemaInput<TBodySchema>>,
  SnsMessage<StandardSchemaOutput<TBodySchema>>
> {
  readonly body: TBodySchema;
  readonly source: "sns";
}

export interface SnsFunctionDefinitionInput<
  TMessageSchema extends AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> {
  /** Keep events this Function fails after Lambda's retries in a dead-letter queue. Default true. */
  readonly deadLetterQueue?: boolean;
  /** A subscription filter policy; SNS only delivers matching messages. */
  readonly filterPolicy?: SnsFilterPolicy;
  /** What `filterPolicy` matches. SNS defaults to `"MessageAttributes"`. */
  readonly filterPolicyScope?: SnsFilterPolicyScope;
  readonly handler: (
    message: SnsMessage<StandardSchemaOutput<TMessageSchema>>,
    context: InvokeContext<TVariables, TResources[number]>
  ) => void | Promise<void>;
  /** A Standard Schema for one JSON message body. */
  readonly message: TMessageSchema;
  readonly name?: string;
  readonly synthesis?: FunctionSynthesisConfig;
  /** The key of an `snsTopic()` resource. */
  readonly topic: string;
  /** Resource Links: the resource keys this Function reads through `context.resource`. */
  readonly resources?: TResources;
  readonly variables?: TVariables;
}

const localAccountId = "000000000000";

const filterPolicyScopes: ReadonlySet<string> = new Set<SnsFilterPolicyScope>([
  "MessageAttributes",
  "MessageBody",
]);

const createSnsRecord = (
  input: SnsEventInvocationInput,
  topic: string
): SnsRecord => {
  if (input.raw !== undefined) {
    return input.raw;
  }

  const topicArn = `arn:aws:sns:local:${localAccountId}:${topic}`;
  const messageAttributes: SnsNotification["MessageAttributes"] = {};

  for (const [name, attribute] of Object.entries(input.attributes ?? {})) {
    messageAttributes[name] = { Type: attribute.type, Value: attribute.value };
  }

  return {
    EventSource: "aws:sns",
    EventSubscriptionArn: `${topicArn}:local`,
    EventVersion: "1.0",
    Sns: {
      Message:
        typeof input.message === "string"
          ? input.message
          : JSON.stringify(input.message),
      MessageAttributes: messageAttributes,
      MessageId: input.id ?? "msg_1",
      Subject: input.subject ?? null,
      Timestamp: new Date().toISOString(),
      TopicArn: topicArn,
      Type: "Notification",
    },
  };
};

const snsMessageSchema = <const TBodySchema extends AnyStandardSchema>(
  body: TBodySchema,
  topic: string
): SnsMessageSchema<TBodySchema> => ({
  body,
  source: "sns",
  "~standard": {
    validate: async (value) => {
      const raw = createSnsRecord(value as SnsEventInvocationInput, topic);
      const notification = raw.Sns;
      const attributes: Record<string, SnsMessageAttribute> = {};

      for (const [name, attribute] of Object.entries(
        notification.MessageAttributes
      )) {
        attributes[name] = { type: attribute.Type, value: attribute.Value };
      }

      const message: SnsMessage<StandardSchemaOutput<TBodySchema>> = {
        attributes,
        body: await parseJsonEventPayload(body, notification.Message, {
          description: "SNS message body",
          id: notification.MessageId,
        }),
        id: notification.MessageId,
        raw,
        timestamp: notification.Timestamp,
        topicArn: notification.TopicArn,
      };

      if (typeof notification.Subject === "string") {
        message.subject = notification.Subject;
      }

      return { value: message };
    },
    vendor: "voke",
    version: 1,
  },
});

const snsEventSource = (
  definition: SnsFunctionDefinitionInput<AnyStandardSchema, never>
): SnsEventSourceDefinition => {
  const properties: {
    deadLetterQueue: boolean;
    filterPolicy?: SnsFilterPolicy;
    filterPolicyScope?: SnsFilterPolicyScope;
  } = { deadLetterQueue: definition.deadLetterQueue ?? true };

  if (definition.filterPolicy !== undefined) {
    properties.filterPolicy = definition.filterPolicy;
  }

  if (definition.filterPolicyScope !== undefined) {
    properties.filterPolicyScope = definition.filterPolicyScope;
  }

  return {
    properties,
    resource: definition.topic,
    source: "sns",
  };
};

/** A Function that SNS invokes with each message published to `topic`. */
export const sns = <
  const TMessageSchema extends AnyStandardSchema,
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: SnsFunctionDefinitionInput<TMessageSchema, TVariables, TResources>
): EventFunctionDefinition<
  string,
  SnsMessageSchema<TMessageSchema>,
  TVariables,
  void
> => {
  if (typeof definition.topic !== "string" || definition.topic === "") {
    throw new VokeConfigError(
      "sns() requires topic, the key of an snsTopic() resource"
    );
  }

  if (
    definition.filterPolicyScope !== undefined &&
    !filterPolicyScopes.has(definition.filterPolicyScope)
  ) {
    throw new VokeConfigError(
      `sns() filterPolicyScope must be "MessageAttributes" or "MessageBody", not ${JSON.stringify(definition.filterPolicyScope)}`
    );
  }

  return Object.freeze({
    events: Object.freeze([
      snsEventSource(
        definition as SnsFunctionDefinitionInput<AnyStandardSchema, never>
      ),
    ]),
    handler: definition.handler,
    input: snsMessageSchema(definition.message, definition.topic),
    key: "",
    kind: "event",
    name: definition.name,
    resources: definition.resources,
    routes: [],
    synthesis: definition.synthesis,
    variables: definition.variables,
  }) as unknown as EventFunctionDefinition<
    string,
    SnsMessageSchema<TMessageSchema>,
    TVariables,
    void
  >;
};

const snsInvocationFromAwsEvent = (
  event: SnsAwsEvent
): SnsEventInvocationInput => {
  const [record] = event.Records ?? [];

  if (record === undefined) {
    throw new InvokeError("Invalid SNS event: it has no record", {
      code: "INVALID_PAYLOAD",
    });
  }

  // The body stays the raw string; the schema parses and validates it, as for local events.
  return { message: record.Sns.Message, raw: record };
};

const topicKind = {
  cloudFormationType: "AWS::SNS::Topic",
  label: "SNS",
} as const;

const topicIssues = (context: AwsEventSourceContext): VokeIssue[] => {
  const issue = eventSourceResourceKindIssue(context, topicKind);

  return [
    ...(issue === undefined ? [] : [issue]),
    ...deadLetterQueueOptionIssues(context),
  ];
};

/** How an SNS Event Source runs on Lambda and synthesizes to a subscription and a permission. */
export const snsEventRuntimeAdapter: AwsEventSourceRuntimeAdapter = {
  source: "sns",
  toInvocation: (event) => snsInvocationFromAwsEvent(event as SnsAwsEvent),
  toResponse: () => {
    // SNS invokes asynchronously and ignores the result.
  },
};

export const snsEventSourceAdapter: AwsEventSourceAdapter = {
  roleStatements: functionDeadLetterQueueStatements,
  source: "sns",
  synthesize: (context) => {
    const issues = topicIssues(context);

    if (issues.length > 0) {
      throw VokeModelError.validation(issues);
    }

    const { eventSource, lambdaLogicalId } = context;
    const topicLogicalId = toLogicalId(eventSource.resource ?? "");
    const { filterPolicy, filterPolicyScope } = eventSource.properties;
    const subscription: Record<string, VokeModelRecord[string]> = {
      Endpoint: { "Fn::GetAtt": [lambdaLogicalId, "Arn"] },
      Protocol: "lambda",
      TopicArn: { Ref: topicLogicalId },
    };

    if (filterPolicy !== undefined) {
      subscription.FilterPolicy = filterPolicy;
    }

    if (filterPolicyScope !== undefined) {
      subscription.FilterPolicyScope = filterPolicyScope;
    }

    const prefix = `${lambdaLogicalId}${topicLogicalId}`;

    return {
      resources: {
        ...asyncFailureResourcesFor(context),
        [`${prefix}Permission`]: lambdaInvokePermissionResource(
          lambdaLogicalId,
          "sns.amazonaws.com",
          { Ref: topicLogicalId }
        ),
        [`${prefix}Subscription`]: {
          Properties: subscription,
          Type: "AWS::SNS::Subscription",
        },
      },
    };
  },
  validate: topicIssues,
};
