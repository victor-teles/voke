// The S3 Event Source: a bucket sends its object events to the account's default EventBridge bus,
// and one EventBridge rule per Function invokes it. Bucket notifications to Lambda are not used:
// they make the bucket depend on the Function, which closes a cycle through the Function's role
// (see docs/adr/0013-s3-event-sources-use-eventbridge.md).
import { VokeConfigError, VokeModelError } from "voke";
import type {
  EventFunctionDefinition,
  InvokeError,
  EventSourceDefinition,
  FunctionSynthesisConfig,
  InvokeContext,
  RuntimeVariableCatalog,
  StandardSchemaV1,
  VokeModelRecord,
} from "voke";

import { toLogicalId } from "./cloudformation-template";
import type { CloudFormationValue } from "./cloudformation-template";
import {
  asyncFailureResourcesFor,
  deadLetterQueueOptionIssues,
  functionDeadLetterQueueStatements,
} from "./dead-letter-queue";
import { invalidEventPayloadError, toAwsEventTime } from "./event-payload";
import { eventSourceResourceKindIssue } from "./event-source-resources";
import type { AwsEventSourceRuntimeAdapter } from "./event-source-runtime";
import type {
  AwsEventSourceAdapter,
  AwsEventSourceContext,
  VokeIssue,
} from "./event-sources";
import { eventBridgeRuleResources } from "./eventbridge";

/** Which object changes an `s3()` Function receives. */
export type S3EventKind = "created" | "deleted";

/** An S3 Event Source as `s3()` stores it: the bucket resource key, the kinds and the key filters. */
export interface S3EventSourceDefinition extends EventSourceDefinition {
  readonly properties: {
    readonly deadLetterQueue: boolean;
    readonly on: S3EventKind[];
    readonly prefix?: string;
    readonly suffix?: string;
  };
  readonly resource: string;
  readonly source: "s3";
}

/** The `detail` of an S3 "Object Created" or "Object Deleted" EventBridge event. */
export interface S3AwsEventDetail {
  bucket: { name: string };
  "deletion-type"?: string;
  "event-version"?: string;
  object: {
    etag?: string;
    key: string;
    sequencer?: string;
    size?: number;
    "version-id"?: string;
  };
  reason?: string;
  "request-id"?: string;
  requester?: string;
  "source-ip-address"?: string;
  version?: string;
}

/** The EventBridge event Lambda receives for an S3 object change. */
export interface S3AwsEvent {
  account: string;
  detail: S3AwsEventDetail;
  "detail-type": string;
  id: string;
  region: string;
  resources: string[];
  source: string;
  time: string;
  version: string;
}

/** What an `s3()` handler receives: one object change. */
export interface S3ObjectEvent {
  /** The bucket name. Locally, the bucket's resource key unless `sendEvent` sets another. */
  bucket: string;
  /** For deletes: "Permanently Deleted" or "Delete Marker Created". */
  deletionType?: string;
  etag?: string;
  id: string;
  /** The object key exactly as EventBridge delivered it; Voke never URL-decodes it. */
  key: string;
  kind: S3EventKind;
  /** The untouched EventBridge event. */
  raw: S3AwsEvent;
  /** The S3 API that caused the change, for example "PutObject" or "CompleteMultipartUpload". */
  reason?: string;
  sequencer?: string;
  /** The object size in bytes. Absent on most delete events. */
  size?: number;
  time: string;
  versionId?: string;
}

/**
 * The input of `functions.sendEvent` for an `s3()` Function. Only `key` is required and is used
 * verbatim. `kind` defaults to the first value of the Function's `on`, `bucket` to the bucket's
 * resource key; Voke fills in the rest of the event.
 */
export interface S3EventInvocationInput {
  bucket?: string;
  etag?: string;
  id?: string;
  key: string;
  kind?: S3EventKind;
  /** The EventBridge event to read instead; the deployed handler passes the event it received. */
  raw?: S3AwsEvent;
  size?: number;
  time?: string;
  versionId?: string;
}

export interface S3ObjectEventSchema extends StandardSchemaV1<
  S3EventInvocationInput,
  S3ObjectEvent
> {
  readonly source: "s3";
}

export interface S3FunctionDefinitionInput<
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> {
  /** The key of an `s3Bucket()` resource. */
  readonly bucket: string;
  /** Keep events this Function fails after Lambda's retries in a dead-letter queue. Default true. */
  readonly deadLetterQueue?: boolean;
  readonly handler: (
    event: S3ObjectEvent,
    context: InvokeContext<TVariables, TResources[number]>
  ) => void | Promise<void>;
  readonly name?: string;
  /** The object changes to receive. Defaults to `["created"]`. */
  readonly on?: readonly S3EventKind[];
  /** Only keys that start with this text, compared with the key as delivered. */
  readonly prefix?: string;
  /** Only keys that end with this text, compared with the key as delivered. */
  readonly suffix?: string;
  readonly synthesis?: FunctionSynthesisConfig;
  /** Resource Links: the resource keys this Function reads through `context.resource`. */
  readonly resources?: TResources;
  readonly variables?: TVariables;
}

const s3EventSource = "aws.s3";
const localAccountId = "000000000000";

const detailTypes: Readonly<Record<S3EventKind, string>> = {
  created: "Object Created",
  deleted: "Object Deleted",
};

const kindOfDetailType = (detailType: string): S3EventKind | undefined => {
  if (detailType === detailTypes.created) {
    return "created";
  }

  if (detailType === detailTypes.deleted) {
    return "deleted";
  }

  return undefined;
};

const isS3EventKind = (value: unknown): value is S3EventKind =>
  value === "created" || value === "deleted";

const invalidS3Event = (id: string, detail: string): InvokeError =>
  invalidEventPayloadError({ description: "S3 event", id }, detail);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Checks the parts of an S3 EventBridge event that Voke reads; the rest stays in `raw`. */
const readS3AwsEvent = (value: unknown): S3AwsEvent => {
  const id =
    isRecord(value) && typeof value.id === "string" ? value.id : "event";

  if (!isRecord(value) || value.source !== s3EventSource) {
    throw invalidS3Event(id, `its source is not "${s3EventSource}"`);
  }

  const { detail } = value;

  if (
    !isRecord(detail) ||
    !isRecord(detail.object) ||
    typeof detail.object.key !== "string"
  ) {
    throw invalidS3Event(id, "it has no detail.object.key");
  }

  if (!isRecord(detail.bucket) || typeof detail.bucket.name !== "string") {
    throw invalidS3Event(id, "it has no detail.bucket.name");
  }

  return value as unknown as S3AwsEvent;
};

const createS3AwsEvent = (
  input: S3EventInvocationInput,
  kind: S3EventKind,
  bucketKey: string
): S3AwsEvent => {
  const bucket = input.bucket ?? bucketKey;
  const object: S3AwsEventDetail["object"] = { key: input.key };

  if (input.size !== undefined) {
    object.size = input.size;
  }

  if (input.etag !== undefined) {
    object.etag = input.etag;
  }

  if (input.versionId !== undefined) {
    object["version-id"] = input.versionId;
  }

  const detail: S3AwsEventDetail = {
    bucket: { name: bucket },
    object,
    reason: kind === "created" ? "PutObject" : "DeleteObject",
    version: "0",
  };

  if (kind === "deleted") {
    detail["deletion-type"] = "Permanently Deleted";
  }

  return {
    account: localAccountId,
    detail,
    "detail-type": detailTypes[kind],
    id: input.id ?? "evt_1",
    region: "local",
    resources: [`arn:aws:s3:::${bucket}`],
    source: s3EventSource,
    time: input.time ?? toAwsEventTime(new Date()),
    version: "0",
  };
};

const toS3ObjectEvent = (raw: S3AwsEvent, kind: S3EventKind): S3ObjectEvent => {
  const { detail } = raw;
  const event: S3ObjectEvent = {
    bucket: detail.bucket.name,
    id: raw.id,
    key: detail.object.key,
    kind,
    raw,
    time: raw.time,
  };
  const { object } = detail;

  if (object.size !== undefined) {
    event.size = object.size;
  }

  if (object.etag !== undefined) {
    event.etag = object.etag;
  }

  if (object["version-id"] !== undefined) {
    event.versionId = object["version-id"];
  }

  if (object.sequencer !== undefined) {
    event.sequencer = object.sequencer;
  }

  if (detail.reason !== undefined) {
    event.reason = detail.reason;
  }

  if (detail["deletion-type"] !== undefined) {
    event.deletionType = detail["deletion-type"];
  }

  return event;
};

/** The raw event for an invocation: the one Lambda delivered, or one built from local input. */
const s3AwsEventFor = (
  input: S3EventInvocationInput,
  on: readonly S3EventKind[],
  bucketKey: string
): S3AwsEvent => {
  if (!isRecord(input)) {
    throw invalidS3Event("evt_1", "sendEvent takes an object with a key");
  }

  if (input.raw !== undefined) {
    return readS3AwsEvent(input.raw);
  }

  if (typeof input.key !== "string" || input.key === "") {
    throw invalidS3Event(input.id ?? "evt_1", "key must be a non-empty string");
  }

  const kind = input.kind ?? on[0] ?? "created";

  if (!isS3EventKind(kind)) {
    throw invalidS3Event(
      input.id ?? "evt_1",
      `kind must be "created" or "deleted", not ${JSON.stringify(kind)}`
    );
  }

  return createS3AwsEvent(input, kind, bucketKey);
};

const s3ObjectEventSchema = (
  on: readonly S3EventKind[],
  bucketKey: string
): S3ObjectEventSchema => ({
  source: "s3",
  "~standard": {
    validate: (value) => {
      const raw = s3AwsEventFor(value as S3EventInvocationInput, on, bucketKey);
      const kind = kindOfDetailType(raw["detail-type"]);

      if (kind === undefined) {
        throw invalidS3Event(
          raw.id,
          `S3 Event Sources handle "Object Created" and "Object Deleted" events, not ${JSON.stringify(raw["detail-type"])}`
        );
      }

      if (!on.includes(kind)) {
        throw invalidS3Event(
          raw.id,
          `this Function receives ${on.map((listened) => JSON.stringify(listened)).join(" and ")} events, not ${JSON.stringify(kind)}`
        );
      }

      return { value: toS3ObjectEvent(raw, kind) };
    },
    vendor: "voke",
    version: 1,
  },
});

const requireNonEmptyFilter = (
  name: "prefix" | "suffix",
  value: string | undefined
): void => {
  if (value !== undefined && (typeof value !== "string" || value === "")) {
    throw new VokeConfigError(
      `s3() ${name} must be a non-empty string; omit it to receive every key`
    );
  }
};

const readEventKinds = (
  on: readonly S3EventKind[] | undefined
): S3EventKind[] => {
  if (on === undefined) {
    return ["created"];
  }

  if (!Array.isArray(on) || on.length === 0) {
    throw new VokeConfigError(
      's3() on must list at least one of "created" and "deleted"; omit it for ["created"]'
    );
  }

  for (const kind of on) {
    if (!isS3EventKind(kind)) {
      throw new VokeConfigError(
        `s3() on accepts only "created" and "deleted", not ${JSON.stringify(kind)}`
      );
    }
  }

  return [...new Set(on)];
};

const s3EventSourceDefinition = (
  bucket: string,
  on: S3EventKind[],
  deadLetterQueue: boolean,
  prefix: string | undefined,
  suffix: string | undefined
): S3EventSourceDefinition => {
  const properties: {
    deadLetterQueue: boolean;
    on: S3EventKind[];
    prefix?: string;
    suffix?: string;
  } = { deadLetterQueue, on };

  if (prefix !== undefined) {
    properties.prefix = prefix;
  }

  if (suffix !== undefined) {
    properties.suffix = suffix;
  }

  return { properties, resource: bucket, source: "s3" };
};

/** A Function that runs for each object created in or deleted from a bucket. */
export const s3 = <
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
  const TResources extends readonly string[] = readonly [],
>(
  definition: S3FunctionDefinitionInput<TVariables, TResources>
): EventFunctionDefinition<string, S3ObjectEventSchema, TVariables, void> => {
  const { bucket, prefix, suffix } = definition;

  if (typeof bucket !== "string" || bucket === "") {
    throw new VokeConfigError(
      "s3() requires bucket, the key of an s3Bucket() resource"
    );
  }

  const on = readEventKinds(definition.on);

  requireNonEmptyFilter("prefix", prefix);
  requireNonEmptyFilter("suffix", suffix);

  // With both filters the rule uses one wildcard pattern, where a literal "*" next to the joining
  // wildcard ("\**" or "*\*") reads as consecutive wildcards, which EventBridge rejects.
  if (
    prefix !== undefined &&
    suffix !== undefined &&
    (prefix.endsWith("*") || suffix.startsWith("*"))
  ) {
    throw new VokeConfigError(
      "s3() prefix cannot end with * and suffix cannot start with * when both are set"
    );
  }

  return Object.freeze({
    events: Object.freeze([
      s3EventSourceDefinition(
        bucket,
        on,
        definition.deadLetterQueue ?? true,
        prefix,
        suffix
      ),
    ]),
    handler: definition.handler,
    input: s3ObjectEventSchema(on, bucket),
    key: "",
    kind: "event",
    name: definition.name,
    resources: definition.resources,
    routes: [],
    synthesis: definition.synthesis,
    variables: definition.variables,
  }) as unknown as EventFunctionDefinition<
    string,
    S3ObjectEventSchema,
    TVariables,
    void
  >;
};

const wildcardSpecialCharacters = /[\\*]/gu;

/** EventBridge's matcher for `detail.object.key`; `undefined` when every key matches. */
const s3KeyMatcher = (
  prefix: string | undefined,
  suffix: string | undefined
): VokeModelRecord | undefined => {
  if (prefix !== undefined && suffix !== undefined) {
    const escape = (value: string): string =>
      value.replaceAll(
        wildcardSpecialCharacters,
        (character) => `\\${character}`
      );

    return { wildcard: `${escape(prefix)}*${escape(suffix)}` };
  }

  if (prefix !== undefined) {
    return { prefix };
  }

  if (suffix !== undefined) {
    return { suffix };
  }

  return undefined;
};

const bucketKind = {
  cloudFormationType: "AWS::S3::Bucket",
  label: "S3",
} as const;

const bucketIssues = (context: AwsEventSourceContext): VokeIssue[] => {
  const issue = eventSourceResourceKindIssue(context, bucketKind);

  return [
    ...(issue === undefined ? [] : [issue]),
    ...deadLetterQueueOptionIssues(context),
  ];
};

const storedProperties = (
  context: AwsEventSourceContext
): S3EventSourceDefinition["properties"] =>
  context.eventSource
    .properties as unknown as S3EventSourceDefinition["properties"];

const isCloudFormationObject = (
  value: CloudFormationValue | undefined
): value is Record<string, CloudFormationValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The bucket's notification settings with EventBridge delivery turned on; the rest is kept. */
const withEventBridgeEnabled = (
  notificationConfiguration: CloudFormationValue | undefined
): CloudFormationValue => ({
  ...(isCloudFormationObject(notificationConfiguration)
    ? notificationConfiguration
    : {}),
  EventBridgeConfiguration: { EventBridgeEnabled: true },
});

/** How an S3 Event Source runs on Lambda and synthesizes to an EventBridge rule and a permission. */
export const s3EventRuntimeAdapter: AwsEventSourceRuntimeAdapter = {
  source: "s3",
  // The key is passed through untouched; the schema reads everything else from `raw`.
  toInvocation: (event) => {
    const raw = readS3AwsEvent(event);

    return {
      key: raw.detail.object.key,
      raw,
    } satisfies S3EventInvocationInput;
  },
  toResponse: () => {
    // EventBridge invokes asynchronously and ignores the result.
  },
};

export const s3EventSourceAdapter: AwsEventSourceAdapter = {
  // The bucket sends its events to EventBridge; other notification settings are kept.
  resourceProperties: (_context, properties) => ({
    ...properties,
    NotificationConfiguration: withEventBridgeEnabled(
      properties.NotificationConfiguration
    ),
  }),
  roleStatements: functionDeadLetterQueueStatements,
  source: "s3",
  synthesize: (context) => {
    const issues = bucketIssues(context);

    if (issues.length > 0) {
      throw VokeModelError.validation(issues);
    }

    const { eventSource, lambdaLogicalId } = context;
    const bucketLogicalId = toLogicalId(eventSource.resource ?? "");
    const { on, prefix, suffix } = storedProperties(context);
    const keyMatcher = s3KeyMatcher(prefix, suffix);
    const detail: VokeModelRecord = {
      bucket: { name: [{ Ref: bucketLogicalId }] },
    };

    if (keyMatcher !== undefined) {
      detail.object = { key: [keyMatcher] };
    }

    return {
      resources: {
        ...asyncFailureResourcesFor(context),
        ...eventBridgeRuleResources({
          lambdaLogicalId,
          pattern: {
            detail,
            detailType: on.map((kind) => detailTypes[kind]),
            source: [s3EventSource],
          },
          ruleLogicalId: `${lambdaLogicalId}${bucketLogicalId}Rule`,
        }),
      },
    };
  },
  validate: bucketIssues,
};
