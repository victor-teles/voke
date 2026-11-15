import { eventBridge, s3, schedule, sns } from "@voke/aws";
import { schema } from "@voke/schema";
import { createFunctions } from "voke";

const orderSchema = schema.object({
  orderId: schema.string(),
  tenantId: schema.string(),
});

export const log: string[] = [];

// Runs for each message published to the ordersTopic SNS topic.
export const orderCreated = sns({
  handler: (message) => {
    log.push(`created ${message.body.tenantId}:${message.body.orderId}`);
  },
  message: orderSchema,
  topic: "ordersTopic",
});

// Runs for each OrderPaid event from the "orders" source on the ordersBus event bus.
export const orderPaid = eventBridge({
  bus: "ordersBus",
  detail: orderSchema,
  handler: (event) => {
    log.push(`paid ${event.detail.tenantId}:${event.detail.orderId}`);
  },
  pattern: { detailType: ["OrderPaid"], source: ["orders"] },
});

// Runs every night at 03:00, São Paulo time.
export const nightlyCleanup = schedule({
  expression: "cron(0 3 * * ? *)",
  handler: (event) => {
    log.push(`cleanup ${event.scheduledTime} attempt ${event.attempt}`);
  },
  timezone: "America/Sao_Paulo",
});

// Runs for each .jpg object created under incoming/ in the uploadsBucket S3 bucket.
export const imageUploaded = s3({
  bucket: "uploadsBucket",
  handler: (event) => {
    log.push(`uploaded ${event.key} (${event.size ?? 0} bytes)`);
  },
  prefix: "incoming/",
  suffix: ".jpg",
});

export const functions = createFunctions({
  imageUploaded,
  nightlyCleanup,
  orderCreated,
  orderPaid,
});
