import { sns } from "@vokejs/aws";
import { schema } from "@vokejs/schema";

export const orderCreated = sns({
  handler: (message) => {
    console.info("created", message.body.orderId);
  },
  message: schema.object({ orderId: schema.string() }),
  topic: "ordersTopic",
});
