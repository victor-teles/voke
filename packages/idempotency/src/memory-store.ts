import { blocksExecution } from "./store";
import type {
  IdempotencyAcquireResult,
  IdempotencyRecord,
  IdempotencyStore,
} from "./store";

/**
 * An Idempotency Store in process memory, for tests. Records live as long as the store object;
 * nothing is shared between stores.
 */
export const memoryStore = (): IdempotencyStore => {
  const records = new Map<string, IdempotencyRecord>();

  const acquire = (
    record: IdempotencyRecord,
    now: number
  ): IdempotencyAcquireResult => {
    const existing = records.get(record.id);

    if (existing !== undefined && blocksExecution(existing, now)) {
      return { acquired: false, existing };
    }

    records.set(record.id, record);

    return { acquired: true };
  };

  const complete = (
    id: string,
    data: string | undefined,
    expiresAt: number
  ): void => {
    const existing = records.get(id);

    if (existing === undefined) {
      return;
    }

    records.set(id, {
      expiresAt,
      id,
      status: "COMPLETED",
      validation: existing.validation,
      ...(data === undefined ? {} : { data }),
    });
  };

  const markResultTooLarge = (id: string, expiresAt: number): void => {
    const existing = records.get(id);

    if (existing === undefined) {
      return;
    }

    records.set(id, {
      expiresAt,
      id,
      status: "RESULT_TOO_LARGE",
      validation: existing.validation,
    });
  };

  return {
    acquire: (record, now) => Promise.resolve(acquire(record, now)),
    complete: (id, data, expiresAt) =>
      Promise.resolve(complete(id, data, expiresAt)),
    markResultTooLarge: (id, expiresAt) =>
      Promise.resolve(markResultTooLarge(id, expiresAt)),
    release: (id) => {
      records.delete(id);

      return Promise.resolve();
    },
  };
};
