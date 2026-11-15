export type IdempotencyErrorCode =
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_KEY_MISSING"
  | "IDEMPOTENCY_PAYLOAD_MISMATCH"
  | "IDEMPOTENCY_RESULT_NOT_SERIALIZABLE";

/**
 * Thrown by `idempotent(...)` when a call cannot run or be replayed. Messages name the Function
 * and the record status, never the key, the payload or the stored result.
 */
export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;

  constructor(
    code: IdempotencyErrorCode,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "IdempotencyError";
    this.code = code;
  }
}
