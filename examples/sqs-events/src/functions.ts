import { sqs } from "@voke/aws";
import { idempotentBatch } from "@voke/idempotency";
import { schema } from "@voke/schema";
import { createFunctions } from "voke";

const orderMessageSchema = schema.object({
  orderId: schema.string(),
  tenantId: schema.string(),
});

const paymentMessageSchema = schema.object({
  amount: schema.number(),
  paymentId: schema.string(),
});

export const processedOrders: string[] = [];
export const settledPayments: string[] = [];

export const processOrder = sqs({
  handler: (batch) => {
    for (const message of batch.messages) {
      processedOrders.push(`${message.body.tenantId}:${message.body.orderId}`);
    }

    return batch.ok();
  },
  message: orderMessageSchema,
  queue: "ordersQueue",
});

// SQS delivers at least once: a payment is settled once per paymentId, however often it arrives.
export const settlePayment = sqs({
  handler: idempotentBatch(
    (message) => {
      settledPayments.push(message.body.paymentId);
    },
    { key: (message) => message.body.paymentId }
  ),
  message: paymentMessageSchema,
  queue: "paymentsQueue",
  // The idempotency Plugin's table is linked like any resource.
  resources: ["idempotencyTable"],
});

export const functions = createFunctions({ processOrder, settlePayment });
