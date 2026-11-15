import {
  formatValidationIssue,
  InvokeError,
  readStandardResult,
  VokeConfigError,
  VokeModelError,
} from "voke";
import type {
  EventFunctionDefinition,
  EventSourceDefinition,
  FunctionSynthesisConfig,
  InvokeContext,
  RuntimeVariableCatalog,
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
} from "voke";

import { resourceProvider, toLogicalId } from "./cloudformation-template";
import type { CloudFormationValue } from "./cloudformation-template";
import {
  fromAttributeValueMap,
  toAttributeValueMap,
} from "./dynamodb-attribute-values";
import type { AttributeValueMap } from "./dynamodb-attribute-values";
import type {
  AwsEventSourceAdapter,
  AwsEventSourceContext,
  VokeIssue,
} from "./event-sources";
import {
  collectStreamRecords,
  streamEventSourceMappingProperties,
  streamEventSourceProperties,
  streamOptionIssues,
} from "./stream-batch";
import type {
  StreamBatchResult,
  StreamEventSourceOptions,
  StreamEventSourceProperties,
  StreamInvalidRecordMode,
  StreamRecordBatchBase,
} from "./stream-batch";

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

export type DynamodbStreamEventName = "INSERT" | "MODIFY" | "REMOVE";

export type DynamodbStreamViewType =
  | "KEYS_ONLY"
  | "NEW_AND_OLD_IMAGES"
  | "NEW_IMAGE"
  | "OLD_IMAGE";

/** A DynamoDB Stream Event Source as `dynamodbStream()` stores it. */
export interface DynamodbStreamEventSourceDefinition extends EventSourceDefinition {
  readonly properties: StreamEventSourceProperties & {
    /** Whether an `item` schema validates the images; it needs a stream that carries images. */
    readonly itemSchema: boolean;
  };
  readonly resource: string;
  readonly source: "dynamodbStream";
}

/** One record of the DynamoDB Streams event Lambda delivers, in attribute-value JSON. */
export interface DynamodbStreamAwsRecord {
  awsRegion: string;
  dynamodb: {
    ApproximateCreationDateTime?: number;
    Keys: AttributeValueMap;
    NewImage?: AttributeValueMap;
    OldImage?: AttributeValueMap;
    SequenceNumber: string;
    SizeBytes: number;
    StreamViewType: DynamodbStreamViewType;
  };
  eventID: string;
  eventName: DynamodbStreamEventName;
  eventSource: "aws:dynamodb";
  eventSourceARN: string;
  eventVersion: string;
  userIdentity?: { principalId: string; type: string };
}

export interface DynamodbStreamAwsEvent {
  Records: DynamodbStreamAwsRecord[];
}

export interface DynamodbStreamValidRecord<TItem> {
  eventName: DynamodbStreamEventName;
  id: string;
  /** The item's primary key attributes, as plain values. */
  keys: Record<string, unknown>;
  /** The item after the change; present when the stream view type carries new images. */
  newItem?: TItem;
  /** The item before the change; present when the stream view type carries old images. */
  oldItem?: TItem;
  raw: DynamodbStreamAwsRecord;
  sequenceNumber: string;
  valid: true;
}

export interface DynamodbStreamInvalidRecord {
  error: InvokeError;
  eventName: DynamodbStreamEventName;
  id: string;
  /** The record as Lambda delivered it, images still in attribute-value JSON. */
  raw: DynamodbStreamAwsRecord;
  sequenceNumber: string;
  valid: false;
}

export interface DynamodbStreamRecordBatch<
  TItem,
> extends StreamRecordBatchBase {
  records: DynamodbStreamValidRecord<TItem>[];
  source: "dynamodbStream";
}

export interface DynamodbStreamRecordBatchIncludeInvalid<
  TItem,
> extends StreamRecordBatchBase {
  records: (DynamodbStreamInvalidRecord | DynamodbStreamValidRecord<TItem>)[];
  source: "dynamodbStream";
}

export interface DynamodbStreamEventInvocationRecord<TItem> {
  eventName: DynamodbStreamEventName;
  /** Defaults to `evt_<position>`. */
  id?: string;
  keys: Record<string, unknown>;
  newItem?: TItem;
  oldItem?: TItem;
  /** A real record; when set, the other fields are ignored. */
  raw?: DynamodbStreamAwsRecord;
  /** Defaults to the record's position in the batch, from `"1"`. */
  sequenceNumber?: string;
}

export interface DynamodbStreamEventInvocationInput<
  TItem = Record<string, unknown>,
> {
  records: DynamodbStreamEventInvocationRecord<TItem>[];
  source?: "dynamodbStream";
}

type ItemOutput<TItemSchema> = TItemSchema extends AnyStandardSchema
  ? StandardSchemaOutput<TItemSchema>
  : Record<string, unknown>;

type ItemInput<TItemSchema> = TItemSchema extends AnyStandardSchema
  ? StandardSchemaInput<TItemSchema>
  : Record<string, unknown>;

export interface DynamodbStreamRecordBatchSchema<
  TItemSchema extends AnyStandardSchema | undefined = undefined,
  TInvalidRecord extends StreamInvalidRecordMode = "fail",
> extends StandardSchemaV1<
  // A Function that keeps invalid records is tested with images of any shape.
  DynamodbStreamEventInvocationInput<
    TInvalidRecord extends "include"
      ? Record<string, unknown>
      : ItemInput<TItemSchema>
  >,
  TInvalidRecord extends "include"
    ? DynamodbStreamRecordBatchIncludeInvalid<ItemOutput<TItemSchema>>
    : DynamodbStreamRecordBatch<ItemOutput<TItemSchema>>
> {
  readonly invalidRecord: TInvalidRecord;
  readonly item: TItemSchema;
  readonly source: "dynamodbStream";
}

export interface DynamodbStreamFunctionDefinitionInput<
  TItemSchema extends AnyStandardSchema | undefined = undefined,
  TInvalidRecord extends StreamInvalidRecordMode = "fail",
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> extends StreamEventSourceOptions {
  readonly handler: (
    batch: StandardSchemaOutput<
      DynamodbStreamRecordBatchSchema<TItemSchema, TInvalidRecord>
    >,
    context: InvokeContext<TVariables>
  ) => StreamBatchResult | Promise<StreamBatchResult>;
  /** Default `"fail"`: a record that cannot be converted or validated is failed and not delivered. */
  readonly invalidRecord?: TInvalidRecord;
  /** An optional Standard Schema for one item image; it validates every image a record carries. */
  readonly item?: TItemSchema;
  readonly name?: string;
  readonly synthesis?: FunctionSynthesisConfig;
  /** The key of a `dynamodbTable({ stream })` resource. */
  readonly table: string;
  readonly variables?: TVariables;
}

const viewTypeFor = (
  record: DynamodbStreamEventInvocationRecord<unknown>
): DynamodbStreamViewType => {
  const hasNew = record.newItem !== undefined;
  const hasOld = record.oldItem !== undefined;

  if (hasNew && hasOld) {
    return "NEW_AND_OLD_IMAGES";
  }

  if (hasNew) {
    return "NEW_IMAGE";
  }

  return hasOld ? "OLD_IMAGE" : "KEYS_ONLY";
};

const imageAttributes = (
  name: "NewImage" | "OldImage",
  item: unknown
): Partial<Record<"NewImage" | "OldImage", AttributeValueMap>> =>
  item === undefined
    ? {}
    : { [name]: toAttributeValueMap(item as Record<string, unknown>) };

const createDynamodbStreamRecord = (
  record: DynamodbStreamEventInvocationRecord<unknown>,
  index: number
): DynamodbStreamAwsRecord => {
  if (record.raw !== undefined) {
    return record.raw;
  }

  const sequenceNumber = record.sequenceNumber ?? String(index + 1);

  return {
    awsRegion: "local",
    dynamodb: {
      ApproximateCreationDateTime: Math.floor(Date.now() / 1000),
      Keys: toAttributeValueMap(record.keys),
      ...imageAttributes("NewImage", record.newItem),
      ...imageAttributes("OldImage", record.oldItem),
      SequenceNumber: sequenceNumber,
      SizeBytes: 0,
      StreamViewType: viewTypeFor(record),
    },
    eventID: record.id ?? `evt_${index + 1}`,
    eventName: record.eventName,
    eventSource: "aws:dynamodb",
    eventSourceARN:
      "arn:aws:dynamodb:local:000000000000:table/local/stream/local",
    eventVersion: "1.1",
  };
};

const validateImage = async (
  schema: AnyStandardSchema | undefined,
  image: AttributeValueMap | undefined,
  label: string
): Promise<unknown> => {
  if (image === undefined) {
    return undefined;
  }

  const item = fromAttributeValueMap(image);

  if (schema === undefined) {
    return item;
  }

  const result = readStandardResult(await schema["~standard"].validate(item));

  if (!result.ok) {
    throw new InvokeError(
      `Invalid ${label}: ${result.issues.map(formatValidationIssue).join("; ")}`,
      { code: "INVALID_PAYLOAD", issues: result.issues }
    );
  }

  return result.value;
};

const parseDynamodbStreamRecord = async (
  schema: AnyStandardSchema | undefined,
  raw: DynamodbStreamAwsRecord
): Promise<DynamodbStreamValidRecord<unknown>> => {
  const keys = fromAttributeValueMap(raw.dynamodb.Keys);
  const newItem = await validateImage(schema, raw.dynamodb.NewImage, "newItem");
  const oldItem = await validateImage(schema, raw.dynamodb.OldImage, "oldItem");

  return {
    eventName: raw.eventName,
    id: raw.eventID,
    keys,
    ...(newItem === undefined ? {} : { newItem }),
    ...(oldItem === undefined ? {} : { oldItem }),
    raw,
    sequenceNumber: raw.dynamodb.SequenceNumber,
    valid: true,
  };
};

const dynamodbStreamRecordBatch = <
  const TItemSchema extends AnyStandardSchema | undefined,
  const TInvalidRecord extends StreamInvalidRecordMode,
>(
  item: TItemSchema,
  invalidRecord: TInvalidRecord
): DynamodbStreamRecordBatchSchema<TItemSchema, TInvalidRecord> => ({
  invalidRecord,
  item,
  source: "dynamodbStream",
  "~standard": {
    validate: async (value) => {
      const input = value as DynamodbStreamEventInvocationInput<unknown>;
      const batch = await collectStreamRecords<
        DynamodbStreamAwsRecord,
        DynamodbStreamInvalidRecord | DynamodbStreamValidRecord<unknown>
      >({
        invalid: (raw, error) => ({
          error,
          eventName: raw.eventName,
          id: raw.eventID,
          raw,
          sequenceNumber: raw.dynamodb.SequenceNumber,
          valid: false,
        }),
        invalidRecord,
        parse: async (raw) => await parseDynamodbStreamRecord(item, raw),
        // A local value DynamoDB cannot store (a Date, say) is a test mistake, so it throws here.
        raws: input.records.map(createDynamodbStreamRecord),
        sequenceNumber: (raw) => raw.dynamodb.SequenceNumber,
        sourceName: "DynamoDB stream",
      });

      return {
        value: { ...batch, source: "dynamodbStream" } as StandardSchemaOutput<
          DynamodbStreamRecordBatchSchema<TItemSchema, TInvalidRecord>
        >,
      };
    },
    vendor: "voke",
    version: 1,
  },
});

export const dynamodbStream = <
  const TItemSchema extends AnyStandardSchema | undefined = undefined,
  const TInvalidRecord extends StreamInvalidRecordMode = "fail",
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
>(
  definition: DynamodbStreamFunctionDefinitionInput<
    TItemSchema,
    TInvalidRecord,
    TVariables
  >
): EventFunctionDefinition<
  string,
  DynamodbStreamRecordBatchSchema<TItemSchema, TInvalidRecord>,
  TVariables,
  StreamBatchResult
> => {
  if (typeof definition.table !== "string" || definition.table === "") {
    throw new VokeConfigError(
      "dynamodbStream() requires table, the key of a dynamodbTable({ stream }) resource"
    );
  }

  const eventSource: DynamodbStreamEventSourceDefinition = {
    properties: {
      ...streamEventSourceProperties(definition),
      itemSchema: definition.item !== undefined,
    },
    resource: definition.table,
    source: "dynamodbStream",
  };

  return Object.freeze({
    events: Object.freeze([eventSource]),
    handler: definition.handler,
    input: dynamodbStreamRecordBatch(
      definition.item as TItemSchema,
      definition.invalidRecord ?? ("fail" as TInvalidRecord)
    ),
    key: "",
    kind: "event",
    name: definition.name,
    routes: [],
    synthesis: definition.synthesis,
    variables: definition.variables,
  }) as unknown as EventFunctionDefinition<
    string,
    DynamodbStreamRecordBatchSchema<TItemSchema, TInvalidRecord>,
    TVariables,
    StreamBatchResult
  >;
};

// Records stay in attribute-value JSON; each one is converted on its own so one bad record
// becomes a single batch item failure instead of failing the whole batch.
const dynamodbStreamInvocationFromAwsEvent = (
  event: DynamodbStreamAwsEvent
): DynamodbStreamEventInvocationInput<unknown> => ({
  records: event.Records.map((record) => ({
    eventName: record.eventName,
    keys: {},
    raw: record,
  })),
  source: "dynamodbStream",
});

const tableIssues = ({
  eventSource,
  eventSourceIndex,
  functionKey,
  model,
}: AwsEventSourceContext): VokeIssue[] => {
  const table = eventSource.resource ?? "";
  const resource = model.resources[table];
  const path = `functions.${functionKey}.eventSources.${eventSourceIndex}`;

  if (resource === undefined) {
    return [
      {
        message: `Function "${functionKey}" DynamoDB stream event source references resource "${table}", but no matching resource is defined.`,
        path: `${path}.resource`,
      },
    ];
  }

  const { cloudFormationType } = resourceProvider(resource);

  if (cloudFormationType !== "AWS::DynamoDB::Table") {
    return [
      {
        message: `Function "${functionKey}" DynamoDB stream event source references resource "${table}", but it is an ${JSON.stringify(cloudFormationType)} resource instead of an "AWS::DynamoDB::Table".`,
        path: `${path}.resource`,
      },
    ];
  }

  const specification = resource.properties.StreamSpecification as
    | { StreamViewType?: unknown }
    | undefined;

  if (specification === undefined) {
    return [
      {
        message: `Function "${functionKey}" DynamoDB stream event source references table "${table}", which has no stream; add stream: "NEW_AND_OLD_IMAGES" to dynamodbTable().`,
        path: `${path}.resource`,
      },
    ];
  }

  if (
    eventSource.properties.itemSchema === true &&
    specification.StreamViewType === "KEYS_ONLY"
  ) {
    return [
      {
        message: `Function "${functionKey}" validates items, but table "${table}" streams KEYS_ONLY records, which carry no item images; remove item or use a stream that carries images.`,
        path: `${path}.properties.itemSchema`,
      },
    ];
  }

  return [];
};

const dynamodbStreamIssues = (context: AwsEventSourceContext): VokeIssue[] => [
  ...tableIssues(context),
  ...streamOptionIssues(context),
];

const tableStreamArn = (
  context: AwsEventSourceContext
): CloudFormationValue => ({
  "Fn::GetAtt": [toLogicalId(context.eventSource.resource ?? ""), "StreamArn"],
});

/** How a DynamoDB Stream Event Source runs on Lambda and synthesizes to an event source mapping. */
export const dynamodbStreamEventSourceAdapter: AwsEventSourceAdapter = {
  // The AWSLambdaDynamoDBExecutionRole actions, the reads scoped to this table's stream.
  // ListStreams only lists stream ARNs and is not tied to one stream, so it alone is on "*".
  roleStatements: (context) => [
    {
      Action: [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
      ],
      Effect: "Allow",
      Resource: tableStreamArn(context),
    },
    {
      Action: ["dynamodb:ListStreams"],
      Effect: "Allow",
      Resource: "*",
    },
  ],
  source: "dynamodbStream",
  synthesize: (context) => {
    const issues = dynamodbStreamIssues(context);

    if (issues.length > 0) {
      throw VokeModelError.validation(issues);
    }

    const { eventSource, lambdaLogicalId } = context;

    return {
      resources: {
        [`${lambdaLogicalId}${toLogicalId(eventSource.resource ?? "")}EventSourceMapping`]:
          {
            Properties: streamEventSourceMappingProperties({
              eventSourceArn: tableStreamArn(context),
              lambdaLogicalId,
              properties: eventSource.properties,
            }),
            Type: "AWS::Lambda::EventSourceMapping",
          },
      },
    };
  },
  toInvocation: (event) =>
    dynamodbStreamInvocationFromAwsEvent(event as DynamodbStreamAwsEvent),
  // The handler already returns Lambda's stream batch response shape.
  toResponse: (result) => result,
  validate: dynamodbStreamIssues,
};
