import { dynamodbStream, kinesis } from "@voke/aws";
import { schema } from "@voke/schema";
import { createFunctions } from "voke";

const clickSchema = schema.object({
  page: schema.string(),
  userId: schema.string(),
});

const orderSchema = schema.object({
  id: schema.string(),
  total: schema.number(),
});

export const pageViews = new Map<string, number>();
export const orderTotals = new Map<string, number>();

// Counts page views from the clicks Kinesis stream.
export const clicks = kinesis({
  handler: (batch) => {
    for (const record of batch.records) {
      pageViews.set(
        record.data.page,
        (pageViews.get(record.data.page) ?? 0) + 1
      );
    }

    return batch.ok();
  },
  record: clickSchema,
  stream: "clicksStream",
});

// Projects the orders table's changes into a read model.
export const orders = dynamodbStream({
  handler: (batch) => {
    for (const record of batch.records) {
      const id = String(record.keys.id);

      if (record.newItem === undefined) {
        orderTotals.delete(id);
      } else {
        orderTotals.set(id, record.newItem.total);
      }
    }

    return batch.ok();
  },
  item: orderSchema,
  table: "ordersTable",
});

export const functions = createFunctions({ clicks, orders });
