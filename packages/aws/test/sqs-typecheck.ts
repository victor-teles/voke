// Compile-time checks for sqs(); `bun run typecheck` runs them.
import type { StandardSchemaV1 } from "voke";

import { sqs } from "../src/index";
import type {
  SqsBatchResult,
  SqsMessageBatch,
  SqsValidMessage,
} from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

// A generic helper that builds an SQS handler from a per-message function, like
// idempotentBatch() in @vokejs/idempotency.
const perMessage =
  <TBody>(
    processMessage: (message: SqsValidMessage<TBody>) => void
  ): ((batch: SqsMessageBatch<TBody>) => SqsBatchResult) =>
  (batch) => {
    for (const message of batch.messages) {
      processMessage(message);
    }

    return batch.ok();
  };

sqs({
  // The helper's message type is inferred from the message schema.
  handler: perMessage((message) => {
    const _orderId: string = message.body.orderId;
    // @ts-expect-error the body has only the schema's fields.
    void message.body.missing;
  }),
  message: schema<{ orderId: string }>(),
  queue: "ordersQueue",
});

sqs({
  handler: (batch) => {
    for (const message of batch.messages) {
      // With invalidMessageBody: "include", a message can be invalid.
      const _body: string | undefined = message.valid
        ? message.body.orderId
        : message.rawBody;
    }

    return batch.ok();
  },
  invalidMessageBody: "include",
  message: schema<{ orderId: string }>(),
  queue: "ordersQueue",
});

// Resource Links: the handler reads only the resource keys the Function lists in `resources`,
// and the message body is still inferred through a generic helper.
sqs({
  handler: (batch, context) => {
    const _table: string = context.resource("ordersTable");
    // @ts-expect-error the Function does not link ordersQueue.
    void context.resource("ordersQueue");

    return batch.ok();
  },
  message: schema<{ orderId: string }>(),
  queue: "ordersQueue",
  resources: ["ordersTable"],
});

sqs({
  handler: perMessage((message) => {
    const _orderId: string = message.body.orderId;
    // @ts-expect-error the body has only the schema's fields.
    void message.body.missing;
  }),
  message: schema<{ orderId: string }>(),
  queue: "ordersQueue",
  resources: ["ordersTable"],
});

sqs({
  handler: (batch, context) => {
    // @ts-expect-error a Function without resources links nothing.
    void context.resource("ordersQueue");

    return batch.ok();
  },
  message: schema<{ orderId: string }>(),
  queue: "ordersQueue",
});

sqs({
  handler: (batch, context) => {
    const _table: string = context.resource("ordersTable");
    // @ts-expect-error the Function does not link ordersQueue.
    void context.resource("ordersQueue");

    for (const message of batch.messages) {
      const _body: string | undefined = message.valid
        ? message.body.orderId
        : message.rawBody;
    }

    return batch.ok();
  },
  invalidMessageBody: "include",
  message: schema<{ orderId: string }>(),
  queue: "ordersQueue",
  resources: ["ordersTable"],
});
