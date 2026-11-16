import { aws } from "@vokejs/aws";
import { sqsQueue } from "@vokejs/aws/cloudformation";
import { idempotency } from "@vokejs/idempotency";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/functions.ts",
  name: "sqs-events",
  // Contributes the idempotencyTable resource that settlePayment records its payments in.
  plugins: [idempotency()],
  provider: aws(),
  resources: {
    ordersQueue: sqsQueue(),
    paymentsQueue: sqsQueue(),
  },
});
