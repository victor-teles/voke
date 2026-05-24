import { createFunctions, sqs } from "voke";
import { createSqsEventHandler } from "voke/invoke";
import { schema } from "voke/schema";

const orderMessageSchema = schema.object({
  orderId: schema.string(),
  tenantId: schema.string(),
});

export const processedOrders: string[] = [];

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

export const functions = createFunctions({ processOrder });

export const handler = createSqsEventHandler({
  function: "processOrder",
  functions,
});
