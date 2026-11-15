// The partial batch response Lambda reads from SQS and stream Event Sources:
// `{ batchItemFailures: [{ itemIdentifier }] }`. Each source names its own result type, because the
// meaning differs: SQS retries each failed message on its own, a stream resumes from the lowest
// failed sequence number.

export interface BatchItemFailure {
  itemIdentifier: string;
}

export interface BatchItemFailures {
  batchItemFailures: BatchItemFailure[];
}

export interface BatchResultBuilder<TItem> extends BatchItemFailures {
  fail(item: TItem): void;
}

/**
 * A batch result the handler can add failures to and return as is. `itemIdentifier` reads the
 * identifier Lambda expects for one item: the message id for SQS, the sequence number for streams.
 */
export const createBatchResult = <TItem>(
  itemIdentifier: (item: TItem) => string,
  failures: readonly BatchItemFailure[] = []
): BatchResultBuilder<TItem> => {
  const batchItemFailures = [...failures];
  const result = { batchItemFailures } as BatchResultBuilder<TItem>;

  // Handlers return the builder itself; keep `fail` out of the serialized batch response.
  Object.defineProperty(result, "fail", {
    enumerable: false,
    value: (item: TItem): void => {
      const identifier = itemIdentifier(item);

      if (
        !batchItemFailures.some(
          (failure) => failure.itemIdentifier === identifier
        )
      ) {
        batchItemFailures.push({ itemIdentifier: identifier });
      }
    },
  });

  return result;
};
