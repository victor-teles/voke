import { eventBridge } from "@voke/aws";
import { schema } from "@voke/schema";

export const orderPaid = eventBridge({
  bus: "ordersBus",
  detail: schema.object({ orderId: schema.string() }),
  handler: (event) => {
    console.info("paid", event.detail.orderId);
  },
  pattern: { detailType: ["OrderPaid"], source: ["orders"] },
});
