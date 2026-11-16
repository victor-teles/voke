import { expect, test } from "bun:test";

import { createLambdaHandlers } from "@vokejs/aws";
import type { SqsAwsEvent, SqsBatchResult, SqsRecord } from "@vokejs/aws";
import { idempotency, memoryStore } from "@vokejs/idempotency";

import { functions, processedOrders, settledPayments } from "../src/functions";

// The handlers `voke build` exports, built with the config as the generated entry does; the
// idempotency Plugin keeps its records in memory instead of DynamoDB.
const handlers = createLambdaHandlers(
  { functions },
  {
    config: {
      name: "sqs-events",
      plugins: [idempotency({ store: memoryStore() })],
    },
  }
) as Record<string, (event: SqsAwsEvent) => Promise<SqsBatchResult>>;

const record = (messageId: string, body: unknown): SqsRecord => ({
  attributes: {},
  awsRegion: "us-east-1",
  body: typeof body === "string" ? body : JSON.stringify(body),
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
  md5OfBody: "",
  messageAttributes: {},
  messageId,
  receiptHandle: `receipt-${messageId}`,
});

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

  const result = await handlers.processOrder?.({
    Records: [
      record("valid", { orderId: "ord_2", tenantId: "tenant_1" }),
      record("invalid", "{}"),
    ],
  });

  expect(processedOrders).toEqual(["tenant_1:ord_2"]);
  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: "invalid" }],
  });
});

test("settles a payment once when SQS delivers it twice", async () => {
  settledPayments.length = 0;
  const payment = { amount: 25, paymentId: "pay_1" };

  const first = await handlers.settlePayment?.({
    Records: [record("m1", payment)],
  });
  // A redelivery, or a second send of the same business event with a new message id.
  const second = await handlers.settlePayment?.({
    Records: [record("m2", payment)],
  });

  expect(settledPayments).toEqual(["pay_1"]);
  expect(first).toEqual({ batchItemFailures: [] });
  expect(second).toEqual({ batchItemFailures: [] });
});
