import { sqs } from "@vokejs/aws";
import { schema } from "@vokejs/schema";

export const processOrder = sqs({
  handler: (batch) => {
    for (const message of batch.messages) {
      console.info("order", message.body.orderId);
    }

    return batch.ok();
  },
  message: schema.object({ orderId: schema.string() }),
  queue: "ordersQueue",
});
