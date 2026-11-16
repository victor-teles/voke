import { kinesis } from "@vokejs/aws";
import { schema } from "@vokejs/schema";

export const clicks = kinesis({
  handler: (batch) => {
    for (const record of batch.records) {
      console.info("view", record.data.page);
    }

    return batch.ok();
  },
  record: schema.object({ page: schema.string() }),
  stream: "clicksStream",
});
