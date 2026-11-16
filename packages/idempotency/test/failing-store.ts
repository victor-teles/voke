import type { IdempotencyStore } from "../src/store";

/**
 * Wraps `store` so each method with an entry in `failures` rejects with that error, without
 * calling the wrapped store. The other methods delegate. To heal the store, wrap it again.
 */
export const failingStore = (
  store: IdempotencyStore,
  failures: Partial<Record<keyof IdempotencyStore, Error>>
): IdempotencyStore => ({
  acquire: (record, now) =>
    failures.acquire === undefined
      ? store.acquire(record, now)
      : Promise.reject(failures.acquire),
  complete: (id, data, expiresAt) =>
    failures.complete === undefined
      ? store.complete(id, data, expiresAt)
      : Promise.reject(failures.complete),
  markResultTooLarge: (id, expiresAt) =>
    failures.markResultTooLarge === undefined
      ? store.markResultTooLarge(id, expiresAt)
      : Promise.reject(failures.markResultTooLarge),
  release: (id) =>
    failures.release === undefined
      ? store.release(id)
      : Promise.reject(failures.release),
});
