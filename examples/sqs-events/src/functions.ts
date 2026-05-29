import { createSqsEventHandler, sqs } from "@voke/aws";
import { schema } from "@voke/schema";
import { createFunctions } from "voke";

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
