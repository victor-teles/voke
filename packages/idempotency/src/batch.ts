import type {
  SqsBatchResult,
  SqsMessageBatch,
  SqsValidMessage,
} from "@voke/aws";

import {
  assertIdempotencyOptions,
  resolveScope,
  runWithOptions,
} from "./idempotent";
import type { IdempotencyOptions } from "./idempotent";

// The message id and receive attributes change on every redelivery, so only the body is compared.
const messageBody = <TBody>(message: SqsValidMessage<TBody>): unknown =>
  message.body;

/**
 * An SQS handler that runs `processMessage` once per Idempotency Key, one message after another.
 * A message whose function throws, or whose key is in progress elsewhere, is reported as a batch
 * item failure so SQS redelivers it; a replayed message counts as success. `validate` defaults to
 * the message body.
 */
export const idempotentBatch = <TBody, TContext>(
  processMessage: (
    message: SqsValidMessage<TBody>,
    context: TContext
  ) => unknown,
  options: IdempotencyOptions<SqsValidMessage<TBody>>
): ((
  batch: SqsMessageBatch<TBody>,
  context: TContext
) => Promise<SqsBatchResult>) => {
  assertIdempotencyOptions(options, "idempotentBatch()");

  return async (batch, context) => {
    // Outside the loop, so a Function that does not link the table fails the invocation instead
    // of reporting every message as a batch item failure.
    resolveScope(options.store);
    const result = batch.batchResult();

    for (const message of batch.messages) {
      try {
        await runWithOptions(message, options, messageBody, () =>
          processMessage(message, context)
        );
      } catch {
        // The message is retried by SQS; the error is not logged, as it may carry payload data.
        result.fail(message);
      }
    }

    return result;
  };
};
