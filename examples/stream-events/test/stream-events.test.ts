import { beforeEach, expect, test } from "bun:test";

import { createLambdaHandlers } from "@vokejs/aws";
import type {
  DynamodbStreamAwsEvent,
  KinesisAwsEvent,
  StreamBatchResult,
} from "@vokejs/aws";

import { functions, orderTotals, pageViews } from "../src/functions";

// The handlers `voke build` exports as `index.clicks` and `index.orders`; no hand-written Lambda glue.
const handlers = createLambdaHandlers({ functions });
const clicksHandler = handlers.clicks as (
  event: KinesisAwsEvent
) => Promise<StreamBatchResult>;
const ordersHandler = handlers.orders as (
  event: DynamodbStreamAwsEvent
) => Promise<StreamBatchResult>;

const kinesisRecord = (sequenceNumber: string, data: string) => ({
  awsRegion: "us-east-1",
  eventID: `shardId-000000000000:${sequenceNumber}`,
  eventName: "aws:kinesis:record" as const,
  eventSource: "aws:kinesis" as const,
  eventSourceARN: "arn:aws:kinesis:us-east-1:123456789012:stream/clicks",
  eventVersion: "1.0",
  invokeIdentityArn: "arn:aws:iam::123456789012:role/clicks",
  kinesis: {
    approximateArrivalTimestamp: 1_700_000_000,
    data: Buffer.from(data).toString("base64"),
    kinesisSchemaVersion: "1.0",
    partitionKey: "u1",
    sequenceNumber,
  },
});

beforeEach(() => {
  pageViews.clear();
  orderTotals.clear();
});

test("counts Kinesis clicks locally through the typed Function Registry", async () => {
  const result = await functions.sendEvent("clicks", {
    records: [
      { data: { page: "/home", userId: "u1" } },
      { data: { page: "/home", userId: "u2" } },
    ],
  });

  expect(pageViews.get("/home")).toBe(2);
  expect(result).toEqual({ batchItemFailures: [] });
});

test("reports an undecodable deployed Kinesis record by its sequence number", async () => {
  const result = await clicksHandler({
    Records: [
      kinesisRecord("100", JSON.stringify({ page: "/a", userId: "u1" })),
      kinesisRecord("101", "not json"),
    ],
  });

  expect(pageViews.get("/a")).toBe(1);
  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "101" }] });
});

test("projects order changes locally through the typed Function Registry", async () => {
  await functions.sendEvent("orders", {
    records: [
      {
        eventName: "INSERT",
        keys: { id: "o1" },
        newItem: { id: "o1", total: 10 },
      },
      {
        eventName: "REMOVE",
        keys: { id: "o2" },
        oldItem: { id: "o2", total: 5 },
      },
    ],
  });

  expect([...orderTotals]).toEqual([["o1", 10]]);
});

test("converts a deployed DynamoDB Streams event and fails an invalid image", async () => {
  const result = await ordersHandler({
    Records: [
      {
        awsRegion: "us-east-1",
        dynamodb: {
          Keys: { id: { S: "o1" } },
          NewImage: { id: { S: "o1" }, total: { N: "12.5" } },
          OldImage: { id: { S: "o1" }, total: { N: "10" } },
          SequenceNumber: "200",
          SizeBytes: 40,
          StreamViewType: "NEW_AND_OLD_IMAGES",
        },
        eventID: "e1",
        eventName: "MODIFY",
        eventSource: "aws:dynamodb",
        eventSourceARN:
          "arn:aws:dynamodb:us-east-1:123456789012:table/orders/stream/2024-01-01T00:00:00.000",
        eventVersion: "1.1",
      },
      {
        awsRegion: "us-east-1",
        dynamodb: {
          Keys: { id: { S: "o2" } },
          NewImage: { id: { S: "o2" }, total: { S: "free" } },
          SequenceNumber: "201",
          SizeBytes: 30,
          StreamViewType: "NEW_AND_OLD_IMAGES",
        },
        eventID: "e2",
        eventName: "INSERT",
        eventSource: "aws:dynamodb",
        eventSourceARN:
          "arn:aws:dynamodb:us-east-1:123456789012:table/orders/stream/2024-01-01T00:00:00.000",
        eventVersion: "1.1",
      },
    ],
  });

  expect([...orderTotals]).toEqual([["o1", 12.5]]);
  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "201" }] });
});
