import { expect, test } from "bun:test";

import { createFunctions, InvokeError, VokeConfigError } from "voke";
import type { StandardSchemaV1 } from "voke";

import { createLambdaHandlers, kinesis } from "../src/index";
import type {
  KinesisAwsEvent,
  KinesisInvalidRecord,
  KinesisRecord,
  KinesisValidRecord,
} from "../src/index";

interface Click {
  userId: string;
}

const clickSchema: StandardSchemaV1<Click, Click> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { userId?: unknown }).userId === "string"
        ? { value: value as Click }
        : { issues: [{ message: "userId must be a string" }] },
    vendor: "voke-test",
    version: 1,
  },
};

const kinesisRecord = (
  sequenceNumber: string,
  data: string
): KinesisRecord => ({
  awsRegion: "us-east-2",
  eventID: `shardId-000000000006:${sequenceNumber}`,
  eventName: "aws:kinesis:record",
  eventSource: "aws:kinesis",
  eventSourceARN: "arn:aws:kinesis:us-east-2:123456789012:stream/clicks",
  eventVersion: "1.0",
  invokeIdentityArn: "arn:aws:iam::123456789012:role/lambda-role",
  kinesis: {
    approximateArrivalTimestamp: 1_545_084_650.987,
    data,
    kinesisSchemaVersion: "1.0",
    partitionKey: "u1",
    sequenceNumber,
  },
});

const base64 = (text: string): string => Buffer.from(text).toString("base64");

const createClicks = (
  seen: (KinesisInvalidRecord | KinesisValidRecord<Click>)[],
  invalidRecord: "fail" | "include" = "fail"
) =>
  createFunctions({
    ingest: kinesis({
      handler: (batch) => {
        seen.push(...batch.records);

        return batch.ok();
      },
      invalidRecord,
      record: clickSchema,
      stream: "clicksStream",
    }),
  });

test("sendEvent delivers plain record data parsed and validated to the handler", async () => {
  const seen: KinesisValidRecord<Click>[] = [];
  const functions = createFunctions({
    ingest: kinesis({
      handler: (batch) => {
        seen.push(...batch.records);

        return batch.ok();
      },
      record: clickSchema,
      stream: "clicksStream",
    }),
  });

  await expect(
    functions.sendEvent("ingest", {
      records: [
        { data: { userId: "u1" } },
        { data: { userId: "u2" }, partitionKey: "p", sequenceNumber: "77" },
      ],
    })
  ).resolves.toEqual({ batchItemFailures: [] });
  expect(seen.map((record) => record.data.userId)).toEqual(["u1", "u2"]);
  expect(seen[0]).toMatchObject({
    id: "shardId-000000000000:1",
    partitionKey: "local",
    sequenceNumber: "1",
    valid: true,
  });
  expect(seen[0]?.arrivedAt).toBeInstanceOf(Date);
  expect(seen[1]).toMatchObject({ partitionKey: "p", sequenceNumber: "77" });
  expect(seen[1]?.raw.kinesis.data).toBe(base64('{"userId":"u2"}'));
});

test("an invalid record becomes a batch item failure keyed by its sequence number", async () => {
  const seen: (KinesisInvalidRecord | KinesisValidRecord<Click>)[] = [];
  const functions = createClicks(seen);

  await expect(
    functions.sendEvent("ingest", {
      records: [
        { data: { userId: "u1" }, sequenceNumber: "10" },
        { data: { userId: 7 } as never, sequenceNumber: "11" },
      ],
    })
  ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "11" }] });
  expect(seen.map((record) => record.sequenceNumber)).toEqual(["10"]);
});

test('"include" mode passes the invalid record with valid: false, the error and the undecoded payload', async () => {
  const seen: (KinesisInvalidRecord | KinesisValidRecord<Click>)[] = [];
  const functions = createClicks(seen, "include");

  await expect(
    functions.sendEvent("ingest", {
      records: [{ data: { userId: 7 }, sequenceNumber: "11" }],
    })
  ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "11" }] });

  const [record] = seen;

  expect(record?.valid).toBe(false);
  expect(record?.valid === false && record.rawData).toBe(
    base64('{"userId":7}')
  );
  expect(record?.valid === false && record.error).toBeInstanceOf(InvokeError);
  expect(record?.valid === false && record.error.code).toBe("INVALID_PAYLOAD");
});

test("the deployed handler accepts a real Kinesis Lambda event", async () => {
  const seen: (KinesisInvalidRecord | KinesisValidRecord<Click>)[] = [];
  const handler = createLambdaHandlers({ functions: createClicks(seen) })
    .ingest as (event: KinesisAwsEvent) => Promise<unknown>;
  const record = kinesisRecord(
    "49590338271490256608559692538361571095921575989136588898",
    base64('{"userId":"u1"}')
  );

  await expect(handler({ Records: [record] })).resolves.toEqual({
    batchItemFailures: [],
  });
  expect(seen).toEqual([
    {
      arrivedAt: new Date(1_545_084_650_987),
      data: { userId: "u1" },
      id: record.eventID,
      partitionKey: "u1",
      raw: record,
      sequenceNumber: record.kinesis.sequenceNumber,
      valid: true,
    },
  ]);
});

test("payload that is not base64, not UTF-8 or not JSON is a record failure, not a thrown error", async () => {
  const seen: (KinesisInvalidRecord | KinesisValidRecord<Click>)[] = [];
  const handler = createLambdaHandlers({ functions: createClicks(seen) })
    .ingest as (event: KinesisAwsEvent) => Promise<unknown>;

  await expect(
    handler({
      Records: [
        kinesisRecord("1", "not base64!"),
        kinesisRecord("2", Buffer.from([0xff, 0xfe]).toString("base64")),
        kinesisRecord("3", base64("not json")),
        kinesisRecord("4", base64('{"userId":"u4"}')),
      ],
    })
  ).resolves.toEqual({
    batchItemFailures: [
      { itemIdentifier: "1" },
      { itemIdentifier: "2" },
      { itemIdentifier: "3" },
    ],
  });
  expect(seen.map((record) => record.sequenceNumber)).toEqual(["4"]);
});

test("batch.batchResult().fail(record) is reflected in the response", async () => {
  const functions = createFunctions({
    ingest: kinesis({
      handler: (batch) => {
        const result = batch.batchResult();

        for (const record of batch.records) {
          if (record.data.userId === "bad") {
            result.fail(record);
          }
        }

        return result;
      },
      record: clickSchema,
      stream: "clicksStream",
    }),
  });

  const result = await functions.sendEvent("ingest", {
    records: [
      { data: { userId: "ok" } },
      { data: { userId: "bad" } },
      { data: { userId: 1 } as never },
    ],
  });

  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: "3" }, { itemIdentifier: "2" }],
  });
  expect(structuredClone(result)).toEqual({
    batchItemFailures: [{ itemIdentifier: "3" }, { itemIdentifier: "2" }],
  });
});

test("kinesis() stores the mapping settings with stream defaults applied", () => {
  const ingest = kinesis({
    handler: (batch) => batch.ok(),
    record: clickSchema,
    stream: "clicksStream",
  });

  expect(ingest.events).toEqual([
    {
      properties: {
        batchSize: 100,
        bisectOnError: true,
        enabled: true,
        maxBatchingWindowSeconds: 0,
        startingPosition: "trimHorizon",
      },
      resource: "clicksStream",
      source: "kinesis",
    },
  ]);
  expect(
    kinesis({
      handler: (batch) => batch.ok(),
      maxRetryAttempts: 5,
      record: clickSchema,
      startingPosition: "latest",
      stream: "clicksStream",
    }).events[0]?.properties
  ).toMatchObject({ maxRetryAttempts: 5, startingPosition: "latest" });
});

test("kinesis() requires a stream", () => {
  expect(() =>
    kinesis({
      handler: () => ({ batchItemFailures: [] }),
      record: clickSchema,
    } as never)
  ).toThrow(VokeConfigError);
});
