import { expect, test } from "bun:test";

import { functions, handler, processedOrders } from "../src/functions";

test("processes SQS events locally through the typed Function Registry", async () => {
  processedOrders.length = 0;

  const result = await functions.sendEvent("processOrder", {
    messages: [
      {
        body: {
          orderId: "ord_1",
          tenantId: "tenant_1",
        },
      },
    ],
  });

  expect(processedOrders).toEqual(["tenant_1:ord_1"]);
  expect(result).toEqual({ batchItemFailures: [] });
});

test("returns partial batch failures for invalid deployed SQS records", async () => {
  processedOrders.length = 0;

  const result = await handler({
    Records: [
      {
        attributes: {},
        awsRegion: "us-east-1",
        body: JSON.stringify({
          orderId: "ord_2",
          tenantId: "tenant_1",
        }),
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
        md5OfBody: "",
        messageAttributes: {},
        messageId: "valid",
        receiptHandle: "receipt-valid",
      },
      {
        attributes: {},
        awsRegion: "us-east-1",
        body: "{}",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
        md5OfBody: "",
        messageAttributes: {},
        messageId: "invalid",
        receiptHandle: "receipt-invalid",
      },
    ],
  });

  expect(processedOrders).toEqual(["tenant_1:ord_2"]);
  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: "invalid" }],
  });
});
