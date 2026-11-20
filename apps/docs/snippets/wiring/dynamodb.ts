import { dynamodbStream } from "@vokejs/aws";
import { schema } from "@vokejs/schema";

export const orderChanged = dynamodbStream({
  handler: (batch) => {
    for (const record of batch.records) {
      console.info("total", record.newItem?.total);
    }

    return batch.ok();
  },
  item: schema.object({ id: schema.string(), total: schema.number() }),
  table: "ordersTable",
});
