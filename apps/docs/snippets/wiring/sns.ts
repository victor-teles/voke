import { sns } from "@voke/aws";
import { schema } from "@voke/schema";

export const orderCreated = sns({
  handler: (message) => {
    console.info("created", message.body.orderId);
  },
  message: schema.object({ orderId: schema.string() }),
  topic: "ordersTopic",
});
