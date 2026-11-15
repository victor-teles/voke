/** One logical operation, as an Idempotency Store keeps it. */
export interface IdempotencyRecord {
  /** `<functionKey>#<name>#<sha256 of the key>`. */
  readonly id: string;
  readonly status: "COMPLETED" | "INPROGRESS";
  /** Epoch seconds. After it, the record no longer blocks a new execution. */
  readonly expiresAt: number;
  /** Epoch milliseconds; only while in progress. After it, a new execution takes the record over. */
  readonly inProgressExpiresAt?: number;
  /** SHA-256 of the input parts chosen with `validate`. */
  readonly validation: string;
  /** The handler result as a JSON string; absent when the handler returned `undefined`. */
  readonly data?: string;
}

export type IdempotencyAcquireResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly existing: IdempotencyRecord };

export interface IdempotencyStore {
  /**
   * Writes an `INPROGRESS` record in one conditional write. The write goes through when no
   * record exists, when the existing one has expired (`expiresAt` before `now`), or when it is
   * `INPROGRESS` with `inProgressExpiresAt` before `now`. Otherwise it returns the existing record.
   * `now` is epoch milliseconds.
   */
  acquire(
    record: IdempotencyRecord,
    now: number
  ): Promise<IdempotencyAcquireResult>;
  /** Marks the record `COMPLETED` with the result and a new `expiresAt` (epoch seconds). */
  complete(
    id: string,
    data: string | undefined,
    expiresAt: number
  ): Promise<void>;
  /** Deletes the record, so the next call runs the handler again. */
  release(id: string): Promise<void>;
}

/** Whether `existing` still blocks a new execution at `now` (epoch milliseconds). */
export const blocksExecution = (
  existing: IdempotencyRecord,
  now: number
): boolean => {
  const nowSeconds = Math.floor(now / 1000);

  if (existing.expiresAt < nowSeconds) {
    return false;
  }

  if (existing.status === "COMPLETED") {
    return true;
  }

  return (
    existing.inProgressExpiresAt === undefined ||
    existing.inProgressExpiresAt >= now
  );
};
