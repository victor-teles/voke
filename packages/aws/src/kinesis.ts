import { Buffer } from "node:buffer";

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
import { functionDeadLetterQueueStatements } from "./dead-letter-queue";
import type { AwsEventSourceRuntimeAdapter } from "./event-source-runtime";
import type {
  AwsEventSourceAdapter,
  AwsEventSourceContext,
  VokeIssue,
} from "./event-sources";
import {
  collectStreamRecords,
  streamEventSourceResources,
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

/** A Kinesis Event Source as `kinesis()` stores it: the stream resource key plus the mapping settings. */
export interface KinesisEventSourceDefinition extends EventSourceDefinition {
  readonly properties: StreamEventSourceProperties;
  readonly resource: string;
  readonly source: "kinesis";
}

/** One record of the Kinesis event Lambda delivers. */
export interface KinesisRecord {
  awsRegion: string;
  eventID: string;
  eventName: "aws:kinesis:record";
  eventSource: "aws:kinesis";
  eventSourceARN: string;
  eventVersion: string;
  invokeIdentityArn: string;
  kinesis: {
    /** Seconds since the epoch, with milliseconds as the fraction. */
    approximateArrivalTimestamp: number;
    /** The record payload, base64-encoded. */
    data: string;
    kinesisSchemaVersion: string;
    partitionKey: string;
    sequenceNumber: string;
  };
}

export interface KinesisAwsEvent {
  Records: KinesisRecord[];
}

interface KinesisRecordMetadata {
  arrivedAt: Date;
  /** The Lambda event id: `<shard id>:<sequence number>`. */
  id: string;
  partitionKey: string;
  raw: KinesisRecord;
  sequenceNumber: string;
}

export interface KinesisValidRecord<TData> extends KinesisRecordMetadata {
  /** The payload, base64-decoded, parsed as JSON and validated by the record schema. */
  data: TData;
  valid: true;
}

export interface KinesisInvalidRecord extends KinesisRecordMetadata {
  error: InvokeError;
  /** The payload as Kinesis delivered it, still base64-encoded. */
  rawData: string;
  valid: false;
}

export interface KinesisRecordBatch<TData> extends StreamRecordBatchBase {
  records: KinesisValidRecord<TData>[];
  source: "kinesis";
}

export interface KinesisRecordBatchIncludeInvalid<
  TData,
> extends StreamRecordBatchBase {
  records: (KinesisInvalidRecord | KinesisValidRecord<TData>)[];
  source: "kinesis";
}

export interface KinesisEventInvocationRecord<TData> {
  /** Kinesis receives it JSON-encoded, as a producer would write it. */
  data: TData;
  /** Defaults to `<shard id>:<sequence number>`. */
  id?: string;
  /** Defaults to `"local"`. */
  partitionKey?: string;
  /** A real record; when set, the other fields are ignored. */
  raw?: KinesisRecord;
  /** Defaults to the record's position in the batch, from `"1"`. */
  sequenceNumber?: string;
}

export interface KinesisEventInvocationInput<TData = unknown> {
  records: KinesisEventInvocationRecord<TData>[];
  source?: "kinesis";
}

export interface KinesisRecordBatchSchema<
  TRecordSchema extends AnyStandardSchema = AnyStandardSchema,
  TInvalidRecord extends StreamInvalidRecordMode = "fail",
> extends StandardSchemaV1<
  // A Function that keeps invalid records is tested with data of any shape.
  KinesisEventInvocationInput<
    TInvalidRecord extends "include"
      ? unknown
      : StandardSchemaInput<TRecordSchema>
  >,
  TInvalidRecord extends "include"
    ? KinesisRecordBatchIncludeInvalid<StandardSchemaOutput<TRecordSchema>>
    : KinesisRecordBatch<StandardSchemaOutput<TRecordSchema>>
> {
  readonly invalidRecord: TInvalidRecord;
  readonly record: TRecordSchema;
  readonly source: "kinesis";
}

export interface KinesisFunctionDefinitionInput<
  TRecordSchema extends AnyStandardSchema,
  TInvalidRecord extends StreamInvalidRecordMode = "fail",
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> extends StreamEventSourceOptions {
  readonly handler: (
    batch: StandardSchemaOutput<
      KinesisRecordBatchSchema<TRecordSchema, TInvalidRecord>
    >,
    context: InvokeContext<TVariables, TResources[number]>
  ) => StreamBatchResult | Promise<StreamBatchResult>;
  /** Default `"fail"`: a record that cannot be decoded or validated is failed and not delivered. */
  readonly invalidRecord?: TInvalidRecord;
  readonly name?: string;
  /** The Standard Schema for one JSON record payload. */
  readonly record: TRecordSchema;
  /** The key of a `kinesisStream()` resource. */
  readonly stream: string;
  readonly synthesis?: FunctionSynthesisConfig;
  /** Resource Links: the resource keys this Function reads through `context.resource`. */
  readonly resources?: TResources;
  readonly variables?: TVariables;
}

const localShardId = "shardId-000000000000";

const createKinesisRecord = (
  record: KinesisEventInvocationRecord<unknown>,
  index: number
): KinesisRecord => {
  if (record.raw !== undefined) {
    return record.raw;
  }

  const sequenceNumber = record.sequenceNumber ?? String(index + 1);
  const json = JSON.stringify(record.data) ?? "";

  return {
    awsRegion: "local",
    eventID: record.id ?? `${localShardId}:${sequenceNumber}`,
    eventName: "aws:kinesis:record",
    eventSource: "aws:kinesis",
    eventSourceARN: "arn:aws:kinesis:local:000000000000:stream/local",
    eventVersion: "1.0",
    invokeIdentityArn: "arn:aws:iam::000000000000:role/local",
    kinesis: {
      approximateArrivalTimestamp: Date.now() / 1000,
      data: Buffer.from(json, "utf-8").toString("base64"),
      kinesisSchemaVersion: "1.0",
      partitionKey: record.partitionKey ?? "local",
      sequenceNumber,
    },
  };
};

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const decodePayload = (data: string): unknown => {
  if (!base64Pattern.test(data)) {
    throw new Error("data is not valid base64");
  }

  return JSON.parse(utf8.decode(Buffer.from(data, "base64"))) as unknown;
};

const metadata = (raw: KinesisRecord): KinesisRecordMetadata => ({
  arrivedAt: new Date(
    Math.round(raw.kinesis.approximateArrivalTimestamp * 1000)
  ),
  id: raw.eventID,
  partitionKey: raw.kinesis.partitionKey,
  raw,
  sequenceNumber: raw.kinesis.sequenceNumber,
});

const parseKinesisRecord = async <TRecordSchema extends AnyStandardSchema>(
  schema: TRecordSchema,
  raw: KinesisRecord
): Promise<KinesisValidRecord<StandardSchemaOutput<TRecordSchema>>> => {
  const result = readStandardResult(
    await schema["~standard"].validate(decodePayload(raw.kinesis.data))
  );

  if (!result.ok) {
    throw new InvokeError(
      `Invalid Kinesis record ${raw.kinesis.sequenceNumber}: ${result.issues.map(formatValidationIssue).join("; ")}`,
      {
        code: "INVALID_PAYLOAD",
        functionName: raw.kinesis.sequenceNumber,
        issues: result.issues,
      }
    );
  }

  return {
    ...metadata(raw),
    data: result.value as StandardSchemaOutput<TRecordSchema>,
    valid: true,
  };
};

const kinesisRecordBatch = <
  const TRecordSchema extends AnyStandardSchema,
  const TInvalidRecord extends StreamInvalidRecordMode,
>(
  record: TRecordSchema,
  invalidRecord: TInvalidRecord
): KinesisRecordBatchSchema<TRecordSchema, TInvalidRecord> => ({
  invalidRecord,
  record,
  source: "kinesis",
  "~standard": {
    validate: async (value) => {
      const input = value as KinesisEventInvocationInput;
      const batch = await collectStreamRecords<
        KinesisRecord,
        KinesisInvalidRecord | KinesisValidRecord<unknown>
      >({
        invalid: (raw, error) => ({
          ...metadata(raw),
          error,
          rawData: raw.kinesis.data,
          valid: false,
        }),
        invalidRecord,
        parse: async (raw) => await parseKinesisRecord(record, raw),
        raws: input.records.map(createKinesisRecord),
        sequenceNumber: (raw) => raw.kinesis.sequenceNumber,
        sourceName: "Kinesis",
      });

      return {
        value: { ...batch, source: "kinesis" } as StandardSchemaOutput<
          KinesisRecordBatchSchema<TRecordSchema, TInvalidRecord>
        >,
      };
    },
    vendor: "voke",
    version: 1,
  },
});

export const kinesis = <
  const TRecordSchema extends AnyStandardSchema,
  const TInvalidRecord extends StreamInvalidRecordMode = "fail",
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: KinesisFunctionDefinitionInput<
    TRecordSchema,
    TInvalidRecord,
    TVariables,
    TResources
  >
): EventFunctionDefinition<
  string,
  KinesisRecordBatchSchema<TRecordSchema, TInvalidRecord>,
  TVariables,
  StreamBatchResult
> => {
  if (typeof definition.stream !== "string" || definition.stream === "") {
    throw new VokeConfigError(
      "kinesis() requires stream, the key of a kinesisStream() resource"
    );
  }

  const eventSource: KinesisEventSourceDefinition = {
    properties: streamEventSourceProperties(definition),
    resource: definition.stream,
    source: "kinesis",
  };

  return Object.freeze({
    events: Object.freeze([eventSource]),
    handler: definition.handler,
    input: kinesisRecordBatch(
      definition.record,
      definition.invalidRecord ?? ("fail" as TInvalidRecord)
    ),
    key: "",
    kind: "event",
    name: definition.name,
    resources: definition.resources,
    routes: [],
    synthesis: definition.synthesis,
    variables: definition.variables,
  }) as unknown as EventFunctionDefinition<
    string,
    KinesisRecordBatchSchema<TRecordSchema, TInvalidRecord>,
    TVariables,
    StreamBatchResult
  >;
};

// Records stay as Lambda delivered them; each one is decoded on its own so one bad payload
// becomes a single batch item failure instead of failing the whole batch.
const kinesisInvocationFromAwsEvent = (
  event: KinesisAwsEvent
): KinesisEventInvocationInput => ({
  records: event.Records.map((record) => ({ data: undefined, raw: record })),
  source: "kinesis",
});

const streamKindIssue = ({
  eventSource,
  eventSourceIndex,
  functionKey,
  model,
}: AwsEventSourceContext): VokeIssue | undefined => {
  const stream = eventSource.resource ?? "";
  const resource = model.resources[stream];
  const path = `functions.${functionKey}.eventSources.${eventSourceIndex}.resource`;

  if (resource === undefined) {
    return {
      message: `Function "${functionKey}" Kinesis event source references resource "${stream}", but no matching resource is defined.`,
      path,
    };
  }

  const { cloudFormationType } = resourceProvider(resource);

  return cloudFormationType === "AWS::Kinesis::Stream"
    ? undefined
    : {
        message: `Function "${functionKey}" Kinesis event source references resource "${stream}", but it is an ${JSON.stringify(cloudFormationType)} resource instead of an "AWS::Kinesis::Stream".`,
        path,
      };
};

const kinesisIssues = (context: AwsEventSourceContext): VokeIssue[] => {
  const kindIssue = streamKindIssue(context);

  return [
    ...(kindIssue === undefined ? [] : [kindIssue]),
    ...streamOptionIssues(context),
  ];
};

const streamArn = (context: AwsEventSourceContext): CloudFormationValue => ({
  "Fn::GetAtt": [toLogicalId(context.eventSource.resource ?? ""), "Arn"],
});

/** How a Kinesis Event Source runs on Lambda and synthesizes to an event source mapping. */
export const kinesisEventRuntimeAdapter: AwsEventSourceRuntimeAdapter = {
  source: "kinesis",
  toInvocation: (event) =>
    kinesisInvocationFromAwsEvent(event as KinesisAwsEvent),
  // The handler already returns Lambda's stream batch response shape.
  toResponse: (result) => result,
};

export const kinesisEventSourceAdapter: AwsEventSourceAdapter = {
  // The actions Lambda's poller needs on a shared-throughput (standard iterator) mapping, scoped
  // to this stream. `ListStreams` is console-only and `SubscribeToShard` is for enhanced fan-out
  // consumers, which Voke does not create.
  roleStatements: (context) => [
    {
      Action: [
        "kinesis:DescribeStream",
        "kinesis:DescribeStreamSummary",
        "kinesis:GetRecords",
        "kinesis:GetShardIterator",
        "kinesis:ListShards",
      ],
      Effect: "Allow",
      Resource: streamArn(context),
    },
    ...functionDeadLetterQueueStatements(context),
  ],
  source: "kinesis",
  synthesize: (context) => {
    const issues = kinesisIssues(context);

    if (issues.length > 0) {
      throw VokeModelError.validation(issues);
    }

    const { eventSource, lambdaLogicalId } = context;

    return {
      resources: streamEventSourceResources({
        eventSource,
        eventSourceArn: streamArn(context),
        lambdaLogicalId,
        mappingLogicalId: `${lambdaLogicalId}${toLogicalId(eventSource.resource ?? "")}EventSourceMapping`,
      }),
    };
  },
  validate: kinesisIssues,
};
