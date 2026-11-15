// What Kinesis and DynamoDB Stream Event Sources share: the mapping options and their defaults,
// the checkpoint batch result, the record loop that turns bad records into batch item failures,
// and the event source mapping they synthesize to.
import { InvokeError } from "voke";
import type { VokeModelRecord } from "voke";

import { createBatchResult } from "./batch-result";
import type { BatchItemFailure } from "./batch-result";
import type { CloudFormationValue } from "./cloudformation-template";
import type { AwsEventSourceContext, VokeIssue } from "./event-sources";

/**
 * The handler result that tells a stream Event Source the first record to deliver again. Lambda
 * resumes from the lowest failed sequence number, so every record after it in the batch, failed
 * or not, is delivered again.
 */
export interface StreamBatchResult {
  batchItemFailures: BatchItemFailure[];
}

export interface StreamBatchResultBuilder extends StreamBatchResult {
  /** Report a record as failed by its sequence number. */
  fail(record: { readonly sequenceNumber: string }): void;
}

export type StreamStartingPosition = "latest" | "trimHorizon";

/** `"fail"` reports a record that cannot be decoded or validated as failed; `"include"` hands it to the handler. */
export type StreamInvalidRecordMode = "fail" | "include";

/** Event source mapping settings shared by `kinesis()` and `dynamodbStream()`. */
export interface StreamEventSourceOptions {
  /** Records per batch, 1 to 10000. Default 100. */
  batchSize?: number;
  /** Split a batch in two and retry when the handler throws. Default true. */
  bisectOnError?: boolean;
  /** Default true. */
  enabled?: boolean;
  /** Seconds to gather records before invoking, 0 to 300. Default 0. */
  maxBatchingWindowSeconds?: number;
  /**
   * Retries before Lambda discards a failing batch, -1 (until the record expires) to 10000.
   * Unset by default: Lambda retries until the record expires, because without a failure
   * destination a capped mapping drops records silently.
   */
  maxRetryAttempts?: number;
  /** Where a new mapping starts reading. Default `"trimHorizon"`, so no record is skipped. */
  startingPosition?: StreamStartingPosition;
}

/** The stored mapping settings: defaults applied, `maxRetryAttempts` only when set. */
export type StreamEventSourceProperties = Required<
  Omit<StreamEventSourceOptions, "maxRetryAttempts">
> &
  Pick<StreamEventSourceOptions, "maxRetryAttempts">;

export const streamEventSourceProperties = (
  options: StreamEventSourceOptions
): StreamEventSourceProperties => ({
  batchSize: options.batchSize ?? 100,
  bisectOnError: options.bisectOnError ?? true,
  enabled: options.enabled ?? true,
  maxBatchingWindowSeconds: options.maxBatchingWindowSeconds ?? 0,
  ...(options.maxRetryAttempts === undefined
    ? {}
    : { maxRetryAttempts: options.maxRetryAttempts }),
  startingPosition: options.startingPosition ?? "trimHorizon",
});

const integerRanges = {
  batchSize: { max: 10_000, min: 1 },
  maxBatchingWindowSeconds: { max: 300, min: 0 },
  maxRetryAttempts: { max: 10_000, min: -1 },
} as const;

const startingPositions: Record<StreamStartingPosition, string> = {
  latest: "LATEST",
  trimHorizon: "TRIM_HORIZON",
};

/** Range checks for the mapping settings of one stream Event Source. */
export const streamOptionIssues = ({
  eventSource,
  eventSourceIndex,
  functionKey,
}: AwsEventSourceContext): VokeIssue[] => {
  const issues: VokeIssue[] = [];
  const path = `functions.${functionKey}.eventSources.${eventSourceIndex}.properties`;

  for (const [option, { max, min }] of Object.entries(integerRanges)) {
    const value = eventSource.properties[option];

    if (value === undefined) {
      continue;
    }

    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      issues.push({
        message: `Function "${functionKey}" ${option} must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}.`,
        path: `${path}.${option}`,
      });
    }
  }

  const { startingPosition } = eventSource.properties;

  if (
    typeof startingPosition !== "string" ||
    !Object.hasOwn(startingPositions, startingPosition)
  ) {
    issues.push({
      message: `Function "${functionKey}" startingPosition must be "trimHorizon" or "latest", got ${JSON.stringify(startingPosition)}.`,
      path: `${path}.startingPosition`,
    });
  }

  return issues;
};

/** The `AWS::Lambda::EventSourceMapping` properties for one stream Event Source. */
export const streamEventSourceMappingProperties = (options: {
  eventSourceArn: CloudFormationValue;
  lambdaLogicalId: string;
  properties: VokeModelRecord;
}): Record<string, CloudFormationValue> => {
  const { properties } = options;
  const mapping: Record<string, CloudFormationValue> = {
    BatchSize: properties.batchSize as number,
    BisectBatchOnFunctionError: properties.bisectOnError as boolean,
    Enabled: properties.enabled as boolean,
    EventSourceArn: options.eventSourceArn,
    FunctionName: { Ref: options.lambdaLogicalId },
    FunctionResponseTypes: ["ReportBatchItemFailures"],
    MaximumBatchingWindowInSeconds:
      properties.maxBatchingWindowSeconds as number,
    StartingPosition:
      startingPositions[properties.startingPosition as StreamStartingPosition],
  };

  if (properties.maxRetryAttempts !== undefined) {
    mapping.MaximumRetryAttempts = properties.maxRetryAttempts as number;
  }

  return mapping;
};

/** The batch every stream handler receives, before the source-specific fields. */
export interface StreamRecordBatchBase {
  /** A result to add failures to; it starts with the records Voke already failed. */
  batchResult(): StreamBatchResultBuilder;
  /** The result for a batch whose records all succeeded, apart from those Voke already failed. */
  ok(): StreamBatchResult;
}

export const invalidRecordError = (
  sourceName: string,
  sequenceNumber: string,
  error: unknown
): InvokeError => {
  if (error instanceof InvokeError) {
    return error;
  }

  return new InvokeError(
    `Invalid ${sourceName} record ${sequenceNumber}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error, code: "INVALID_PAYLOAD", functionName: sequenceNumber }
  );
};

/**
 * Parses every record on its own. A record whose `parse` throws never fails the whole batch: it
 * becomes a batch item failure, and in `"include"` mode the handler still receives it as `invalid`.
 */
export const collectStreamRecords = async <TRaw, TRecord>(options: {
  invalid: (raw: TRaw, error: InvokeError) => TRecord;
  invalidRecord: StreamInvalidRecordMode;
  parse: (raw: TRaw) => Promise<TRecord>;
  raws: readonly TRaw[];
  sequenceNumber: (raw: TRaw) => string;
  sourceName: string;
}): Promise<StreamRecordBatchBase & { records: TRecord[] }> => {
  const failures: BatchItemFailure[] = [];
  const records: TRecord[] = [];

  for (const raw of options.raws) {
    try {
      records.push(await options.parse(raw));
    } catch (error) {
      const sequenceNumber = options.sequenceNumber(raw);

      failures.push({ itemIdentifier: sequenceNumber });

      if (options.invalidRecord === "include") {
        records.push(
          options.invalid(
            raw,
            invalidRecordError(options.sourceName, sequenceNumber, error)
          )
        );
      }
    }
  }

  return {
    batchResult: () =>
      createBatchResult(
        (record: { readonly sequenceNumber: string }) => record.sequenceNumber,
        failures
      ),
    ok: () => ({ batchItemFailures: [...failures] }),
    records,
  };
};
