import {
  createSqsEventHandler,
  defineFunction,
  defineFunctions,
  sqsEventSource,
  sqsMessageBatch,
} from "voke";
import type { StandardSchemaV1 } from "voke";

const orderMessageSchema: StandardSchemaV1<
  unknown,
  { orderId: string; tenantId: string }
> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "orderId" in value &&
      typeof value.orderId === "string" &&
      "tenantId" in value &&
      typeof value.tenantId === "string"
        ? {
            data: {
              orderId: value.orderId,
              tenantId: value.tenantId,
            },
            success: true,
          }
        : {
            issues: [{ message: "orderId and tenantId are required" }],
            success: false,
          },
    vendor: "voke-example",
    version: 1,
  },
};

export const processedOrders: string[] = [];

export const processOrder = defineFunction({
  events: [sqsEventSource("ordersQueue")],
  handler: (batch) => {
    for (const message of batch.messages) {
      processedOrders.push(`${message.body.tenantId}:${message.body.orderId}`);
    }

    return batch.ok();
  },
  input: sqsMessageBatch(orderMessageSchema),
});

export const functions = defineFunctions({ processOrder });

export const handler = createSqsEventHandler({
  function: "processOrder",
  functions,
});
