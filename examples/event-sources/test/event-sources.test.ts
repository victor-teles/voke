import { beforeEach, expect, test } from "bun:test";

import { createLambdaHandlers } from "@voke/aws";

import { functions, log } from "../src/functions";

// The handlers `voke build` exports as `index.<Function key>`; no hand-written Lambda glue.
const handlers = createLambdaHandlers({ functions });

beforeEach(() => {
  log.length = 0;
});

test("handles an SNS message locally through the typed Function Registry", async () => {
  await functions.sendEvent("orderCreated", {
    message: { orderId: "ord_1", tenantId: "tenant_1" },
  });

  expect(log).toEqual(["created tenant_1:ord_1"]);
});

test("handles an EventBridge event locally through the typed Function Registry", async () => {
  await functions.sendEvent("orderPaid", {
    detail: { orderId: "ord_1", tenantId: "tenant_1" },
  });

  expect(log).toEqual(["paid tenant_1:ord_1"]);
});

test("runs the scheduled Function locally", async () => {
  await functions.sendEvent("nightlyCleanup", {
    scheduledTime: "2024-03-01T06:00:00Z",
  });

  expect(log).toEqual(["cleanup 2024-03-01T06:00:00Z attempt 1"]);
});

test("the deployed SNS handler fails the invocation for an invalid message", async () => {
  await expect(
    handlers.orderCreated?.({
      Records: [
        {
          EventSource: "aws:sns",
          EventSubscriptionArn:
            "arn:aws:sns:us-east-1:123456789012:orders:subscription",
          EventVersion: "1.0",
          Sns: {
            Message: JSON.stringify({ orderId: "ord_2" }),
            MessageAttributes: {},
            MessageId: "message-1",
            Subject: null,
            Timestamp: "2024-03-01T12:00:00.000Z",
            TopicArn: "arn:aws:sns:us-east-1:123456789012:orders",
            Type: "Notification",
          },
        },
      ],
    })
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  expect(log).toEqual([]);
});

test("the deployed EventBridge handler receives the event detail", async () => {
  await handlers.orderPaid?.({
    account: "123456789012",
    detail: { orderId: "ord_3", tenantId: "tenant_1" },
    "detail-type": "OrderPaid",
    id: "event-1",
    region: "us-east-1",
    resources: [],
    source: "orders",
    time: "2024-03-01T12:00:00Z",
    version: "0",
  });

  expect(log).toEqual(["paid tenant_1:ord_3"]);
});

test("the deployed schedule handler reads the envelope its schedule sends", async () => {
  await handlers.nightlyCleanup?.({
    attempt: "2",
    executionId: "d32c5kddcf5bb8c3",
    scheduledTime: "2024-03-01T06:00:00Z",
    voke: "schedule",
  });

  expect(log).toEqual(["cleanup 2024-03-01T06:00:00Z attempt 2"]);
});
