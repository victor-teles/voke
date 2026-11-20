import { expect, test } from "bun:test";

import { createFunctions, InvokeError, VokeConfigError } from "voke";
import type { StandardSchemaV1 } from "voke";

import { createLambdaHandlers, dynamodbStream } from "../src/index";
import type {
  DynamodbStreamAwsEvent,
  DynamodbStreamAwsRecord,
  DynamodbStreamInvalidRecord,
  DynamodbStreamValidRecord,
} from "../src/index";

interface Order {
  id: string;
  total: number;
}

const orderSchema: StandardSchemaV1<Order, Order> = {
  "~standard": {
    validate: (value) =>
      typeof (value as { total?: unknown }).total === "number"
        ? { value: value as Order }
        : { issues: [{ message: "total must be a number" }] },
    vendor: "voke-test",
    version: 1,
  },
};

const streamRecord = (
  sequenceNumber: string,
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  images: Pick<DynamodbStreamAwsRecord["dynamodb"], "NewImage" | "OldImage">,
  streamViewType: DynamodbStreamAwsRecord["dynamodb"]["StreamViewType"] = "NEW_AND_OLD_IMAGES"
): DynamodbStreamAwsRecord => ({
  awsRegion: "us-east-2",
  dynamodb: {
    ApproximateCreationDateTime: 1_718_047_576,
    Keys: { id: { S: "o1" } },
    ...images,
    SequenceNumber: sequenceNumber,
    SizeBytes: 26,
    StreamViewType: streamViewType,
  },
  eventID: `event-${sequenceNumber}`,
  eventName,
  eventSource: "aws:dynamodb",
  eventSourceARN:
    "arn:aws:dynamodb:us-east-2:123456789012:table/orders/stream/2024-06-10T19:26:16.525",
  eventVersion: "1.1",
});

type Seen = (DynamodbStreamInvalidRecord | DynamodbStreamValidRecord<Order>)[];

const createProjection = (
  seen: Seen,
  invalidRecord: "fail" | "include" = "fail"
) =>
  createFunctions({
    project: dynamodbStream({
      handler: (batch) => {
        seen.push(...batch.records);

        return batch.ok();
      },
      invalidRecord,
      item: orderSchema,
      table: "ordersTable",
    }),
  });

test("sendEvent delivers plain keys and images to the handler", async () => {
  const seen: Seen = [];
  const functions = createProjection(seen);

  await expect(
    functions.sendEvent("project", {
      records: [
        {
          eventName: "INSERT",
          keys: { id: "o1" },
          newItem: { id: "o1", total: 10 },
        },
      ],
    })
  ).resolves.toEqual({ batchItemFailures: [] });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    eventName: "INSERT",
    keys: { id: "o1" },
    newItem: { id: "o1", total: 10 },
    sequenceNumber: "1",
    valid: true,
  });
  expect(seen[0]?.raw.dynamodb.NewImage).toEqual({
    id: { S: "o1" },
    total: { N: "10" },
  });
});

const orderImage = (total: string) => ({
  id: { S: "o1" },
  total: { N: total },
});

test("INSERT, MODIFY and REMOVE records map to newItem and oldItem", async () => {
  const seen: Seen = [];
  const handler = createLambdaHandlers({ functions: createProjection(seen) })
    .project as (event: DynamodbStreamAwsEvent) => Promise<unknown>;
  const image = orderImage;

  await expect(
    handler({
      Records: [
        streamRecord("1", "INSERT", { NewImage: image("10") }),
        streamRecord("2", "MODIFY", {
          NewImage: image("12"),
          OldImage: image("10"),
        }),
        streamRecord("3", "REMOVE", { OldImage: image("12") }),
      ],
    })
  ).resolves.toEqual({ batchItemFailures: [] });
  expect(
    seen.map((record) =>
      record.valid
        ? [record.eventName, record.oldItem?.total, record.newItem?.total]
        : []
    )
  ).toEqual([
    ["INSERT", undefined, 10],
    ["MODIFY", 10, 12],
    ["REMOVE", 12, undefined],
  ]);
});

test("a REMOVE record from a NEW_IMAGE stream has neither image and is valid", async () => {
  const seen: Seen = [];
  const handler = createLambdaHandlers({ functions: createProjection(seen) })
    .project as (event: DynamodbStreamAwsEvent) => Promise<unknown>;
  const record = streamRecord("9", "REMOVE", {}, "NEW_IMAGE");

  await expect(handler({ Records: [record] })).resolves.toEqual({
    batchItemFailures: [],
  });
  expect(seen).toEqual([
    {
      eventName: "REMOVE",
      id: "event-9",
      keys: { id: "o1" },
      raw: record,
      sequenceNumber: "9",
      valid: true,
    },
  ]);
});

test("item validates every image that is present", async () => {
  const seen: Seen = [];
  const handler = createLambdaHandlers({ functions: createProjection(seen) })
    .project as (event: DynamodbStreamAwsEvent) => Promise<unknown>;

  await expect(
    handler({
      Records: [
        streamRecord("1", "MODIFY", {
          NewImage: { id: { S: "o1" }, total: { N: "1" } },
          OldImage: { id: { S: "o1" }, total: { S: "one" } },
        }),
        streamRecord("2", "INSERT", { NewImage: { id: { S: "o2" } } }),
        streamRecord("3", "INSERT", {
          NewImage: { id: { S: "o3" }, total: { X: "?" } as never },
        }),
        streamRecord("4", "INSERT", {
          NewImage: { id: { S: "o4" }, total: { N: "4" } },
        }),
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

test('"include" mode passes an invalid record with valid: false and its error', async () => {
  const seen: Seen = [];
  const functions = createProjection(seen, "include");

  await expect(
    functions.sendEvent("project", {
      records: [
        { eventName: "INSERT", keys: { id: "o1" }, newItem: { id: "o1" } },
      ],
    })
  ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "1" }] });
  expect(seen[0]?.valid).toBe(false);
  expect(seen[0]?.valid === false && seen[0].error).toBeInstanceOf(InvokeError);
  expect(seen[0]?.raw.dynamodb.NewImage).toEqual({ id: { S: "o1" } });
});

test("without an item schema the images are plain records and every record is valid", async () => {
  const seen: unknown[] = [];
  const functions = createFunctions({
    audit: dynamodbStream({
      handler: (batch) => {
        for (const record of batch.records) {
          seen.push(record.newItem?.anything);
        }

        return batch.ok();
      },
      table: "ordersTable",
    }),
  });

  await functions.sendEvent("audit", {
    records: [
      { eventName: "INSERT", keys: { id: "o1" }, newItem: { anything: 1 } },
    ],
  });
  expect(seen).toEqual([1]);
});

test("batch.batchResult().fail(record) reports the record's sequence number", async () => {
  const functions = createFunctions({
    project: dynamodbStream({
      handler: (batch) => {
        const result = batch.batchResult();
        const [first] = batch.records;

        if (first !== undefined) {
          result.fail(first);
        }

        return result;
      },
      table: "ordersTable",
    }),
  });

  await expect(
    functions.sendEvent("project", {
      records: [
        { eventName: "REMOVE", keys: { id: "o1" }, sequenceNumber: "500" },
      ],
    })
  ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "500" }] });
});

test("dynamodbStream() stores the mapping settings and whether it validates items", () => {
  expect(
    dynamodbStream({
      batchSize: 10,
      handler: (batch) => batch.ok(),
      item: orderSchema,
      table: "ordersTable",
    }).events
  ).toEqual([
    {
      properties: {
        batchSize: 10,
        bisectOnError: true,
        deadLetterQueue: true,
        enabled: true,
        itemSchema: true,
        maxBatchingWindowSeconds: 0,
        maxRetryAttempts: 10,
        startingPosition: "trimHorizon",
      },
      resource: "ordersTable",
      source: "dynamodbStream",
    },
  ]);
  expect(() =>
    dynamodbStream({ handler: () => ({ batchItemFailures: [] }) } as never)
  ).toThrow(VokeConfigError);
});
