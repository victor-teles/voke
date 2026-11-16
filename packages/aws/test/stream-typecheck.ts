// Compile-time contract for kinesis() and dynamodbStream(); checked by `bun run typecheck`.
import { createFunctions } from "voke";
import type { StandardSchemaV1 } from "voke";

import { dynamodbStream, kinesis } from "../src/index";
import type {
  DynamodbStreamInvalidRecord,
  KinesisInvalidRecord,
  StreamBatchResult,
} from "../src/index";

const schema = <TInput, TOutput = TInput>(): StandardSchemaV1<
  TInput,
  TOutput
> => ({
  "~standard": {
    validate: (value) => ({ value: value as unknown as TOutput }),
    vendor: "voke-test",
    version: 1,
  },
});

const functions = createFunctions({
  audit: dynamodbStream({
    handler: (batch) => {
      for (const record of batch.records) {
        // Without an item schema, images are plain records.
        const _image: Record<string, unknown> | undefined = record.newItem;
      }

      return batch.ok();
    },
    table: "ordersTable",
  }),
  ingest: kinesis({
    handler: (batch) => {
      for (const record of batch.records) {
        const _userId: string = record.data.userId;
        const _sequenceNumber: string = record.sequenceNumber;
        const _arrivedAt: Date = record.arrivedAt;
        // @ts-expect-error the record type comes from the schema output.
        void record.data.missing;
      }

      const result = batch.batchResult();
      const [first] = batch.records;

      if (first !== undefined) {
        result.fail(first);
      }

      return result;
    },
    record: schema<{ userId: string }>(),
    stream: "clicksStream",
  }),
  ingestAll: kinesis({
    handler: (batch) => {
      for (const record of batch.records) {
        if (record.valid) {
          const _userId: string = record.data.userId;
        } else {
          const _invalid: KinesisInvalidRecord = record;
          const _payload: string = record.rawData;
        }
      }

      return batch.ok();
    },
    invalidRecord: "include",
    record: schema<{ userId: string }>(),
    stream: "clicksStream",
  }),
  project: dynamodbStream({
    handler: (batch) => {
      for (const record of batch.records) {
        const _eventName: "INSERT" | "MODIFY" | "REMOVE" = record.eventName;
        const _total: number | undefined = record.newItem?.total;
        const _oldTotal: number | undefined = record.oldItem?.total;
      }

      return batch.ok();
    },
    item: schema<{ id: string; total: number }>(),
    table: "ordersTable",
  }),
  projectAll: dynamodbStream({
    handler: (batch) => {
      for (const record of batch.records) {
        if (!record.valid) {
          const _invalid: DynamodbStreamInvalidRecord = record;
        }
      }

      return batch.ok();
    },
    invalidRecord: "include",
    item: schema<{ id: string; total: number }>(),
    table: "ordersTable",
  }),
});

export const _ingestResult: Promise<StreamBatchResult> = functions.sendEvent(
  "ingest",
  { records: [{ data: { userId: "u1" } }] }
);

export const _projectResult: Promise<StreamBatchResult> = functions.sendEvent(
  "project",
  {
    records: [
      {
        eventName: "INSERT",
        keys: { id: "o1" },
        newItem: { id: "o1", total: 10 },
      },
    ],
  }
);

// "include" mode accepts data of any shape, so invalid records can be tested.
export const _ingestAllResult: Promise<StreamBatchResult> = functions.sendEvent(
  "ingestAll",
  { records: [{ data: { userId: 7 } }] }
);

export const _wrongData = functions.sendEvent("ingest", {
  // @ts-expect-error data must match the record schema input.
  records: [{ data: { userId: 1 } }],
});

export const _wrongEventName = functions.sendEvent("project", {
  // @ts-expect-error eventName is INSERT, MODIFY or REMOVE.
  records: [{ eventName: "UPSERT", keys: {} }],
});

export const _wrongItem = functions.sendEvent("project", {
  // @ts-expect-error newItem must match the item schema input.
  records: [{ eventName: "INSERT", keys: {}, newItem: { id: "o1" } }],
});

export const _missingRecords = functions.sendEvent(
  "ingest",
  // @ts-expect-error a Kinesis Event Invocation carries records, not messages.
  { messages: [] }
);

kinesis({
  // @ts-expect-error a stream handler returns a StreamBatchResult.
  handler: () => "done",
  record: schema<{ userId: string }>(),
  stream: "clicksStream",
});

kinesis({
  handler: (batch) => batch.ok(),
  record: schema<{ userId: string }>(),
  // @ts-expect-error startingPosition is "trimHorizon" or "latest".
  startingPosition: "TRIM_HORIZON",
  stream: "clicksStream",
});

// Resource Links: each handler reads only the resource keys its Function lists in `resources`.
createFunctions({
  linkedAudit: dynamodbStream({
    handler: (batch, context) => {
      const _bucket: string = context.resource("auditBucket");
      // @ts-expect-error the Function does not link ordersTable.
      void context.resource("ordersTable");

      return batch.ok();
    },
    resources: ["auditBucket"],
    table: "ordersTable",
  }),
  linkedClicks: kinesis({
    handler: (batch, context) => {
      const _id: string | undefined = batch.records[0]?.data.id;
      const _bucket: string = context.resource("auditBucket");
      // @ts-expect-error the Function does not link clicksStream.
      void context.resource("clicksStream");

      return batch.ok();
    },
    record: schema<{ id: string }>(),
    resources: ["auditBucket"],
    stream: "clicksStream",
  }),
  unlinkedAudit: dynamodbStream({
    handler: (batch, context) => {
      // @ts-expect-error a Function without resources links nothing.
      void context.resource("ordersTable");

      return batch.ok();
    },
    table: "ordersTable",
  }),
  unlinkedClicks: kinesis({
    handler: (batch, context) => {
      // @ts-expect-error a Function without resources links nothing.
      void context.resource("clicksStream");

      return batch.ok();
    },
    record: schema<{ id: string }>(),
    stream: "clicksStream",
  }),
});
