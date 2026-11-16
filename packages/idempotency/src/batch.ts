import type {
  SqsBatchResult,
  SqsMessageBatch,
  SqsValidMessage,
} from "@voke/aws";

import { IdempotencyError } from "./errors";
import type { IdempotencyErrorCode } from "./errors";
import {
  assertIdempotencyOptions,
  resolveScope,
  runWithOptions,
} from "./idempotent";
import type { IdempotencyOptions } from "./idempotent";

// The message id and receive attributes change on every redelivery, so only the body is compared.
const messageBody = <TBody>(message: SqsValidMessage<TBody>): unknown =>
  message.body;

// The idempotency outcomes that belong to one message, not to the store or the configuration.
const messageScopedCodes: ReadonlySet<IdempotencyErrorCode> = new Set([
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_KEY_MISSING",
  "IDEMPOTENCY_PAYLOAD_MISMATCH",
]);

const isMessageScoped = (error: unknown, handlerFailed: boolean): boolean =>
  handlerFailed ||
  (error instanceof IdempotencyError && messageScopedCodes.has(error.code));

const isInProgress = (error: unknown): boolean =>
  error instanceof IdempotencyError && error.code === "IDEMPOTENCY_IN_PROGRESS";

/**
 * An SQS handler that runs `processMessage` once per Idempotency Key, one message after another.
 * A message whose function throws, whose key is in progress elsewhere, whose payload differs from
 * the first delivery, or whose key is missing with `onMissingKey: "throw"` is reported as a batch
 * item failure so SQS redelivers it, and logged with its message id (except an in-progress
 * duplicate). Any other error, such as a store or configuration failure, fails the Event
 * Invocation. A replayed message counts as success. The value `processMessage` returns is not
 * stored. `validate` defaults to the message body.
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
      // An object, not a `let`: TypeScript does not see an assignment made inside the callback.
      const attempt = { handlerFailed: false };

      try {
        await runWithOptions(message, options, messageBody, async () => {
          try {
            // The SQS handler reads no result, so none is stored.
            await processMessage(message, context);
          } catch (error) {
            attempt.handlerFailed = true;
            throw error;
          }
        });
      } catch (error) {
        if (!isMessageScoped(error, attempt.handlerFailed)) {
          // A store or configuration failure: fail the Event Invocation, so Lambda reports it and
          // SQS redelivers the batch. Completed messages replay as successes.
          throw error;
        }

        if (attempt.handlerFailed || !isInProgress(error)) {
          console.error(
            `idempotentBatch() reports SQS message "${message.id}" as failed`,
            error
          );
        }

        result.fail(message);
      }
    }

    return result;
  };
};
