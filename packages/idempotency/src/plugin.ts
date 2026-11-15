// Run-time module: deployed Functions import it through voke.config.ts.
import { bindResource } from "@voke/aws";
import { dynamodbTable } from "@voke/aws/cloudformation";
import type { VokePlugin } from "voke";

import { dynamoDbStore } from "./dynamodb-store";
import {
  assertExpiresAfterSeconds,
  defaultExpiresAfterSeconds,
  idempotencyScope,
} from "./idempotent";
import type { IdempotencyStore } from "./store";

export interface IdempotencyPluginOptions {
  /** The resource key of the table the Plugin contributes. Default `"idempotencyTable"`. */
  readonly table?: string;
  /** How long a completed record replays its result, in seconds. Default 3600. */
  readonly expiresAfterSeconds?: number;
  /** A store used instead of the DynamoDB table; no table is contributed. For tests. */
  readonly store?: IdempotencyStore;
}

const defaultTable = "idempotencyTable";

/**
 * The idempotency Plugin for `voke.config.ts`. It contributes a DynamoDB table, readable and
 * writable by every Function, and runs every handler in the scope `idempotent(...)` reads.
 */
export const idempotency = (
  options: IdempotencyPluginOptions = {}
): VokePlugin => {
  const table = options.table ?? defaultTable;
  const expiresAfterSeconds =
    options.expiresAfterSeconds ?? defaultExpiresAfterSeconds;

  assertExpiresAfterSeconds(expiresAfterSeconds, "idempotency()");

  // The table name is read from the binding on first use, so synthesis, builds and tests that
  // never call an idempotent handler need neither the variable nor AWS.
  const store =
    options.store ??
    dynamoDbStore({ tableName: () => bindResource(table, "name").value() });

  return {
    name: "idempotency",
    ...(options.store === undefined
      ? {
          contributions: {
            resources: {
              [table]: dynamodbTable({
                partitionKey: "id",
                ttlAttribute: "expiration",
              }),
            },
          },
        }
      : {}),
    runtime: {
      setup: ({ config, functions }) => {
        const timeouts = new Map(
          functions.map(([key, definition]) => [
            key,
            definition.synthesis?.timeout ?? config.runtime.timeout,
          ])
        );

        return {
          wrap: async (execution, next) =>
            await idempotencyScope.run(
              {
                expiresAfterSeconds,
                functionKey: execution.functionKey,
                store,
                timeoutSeconds:
                  timeouts.get(execution.functionKey) ?? config.runtime.timeout,
              },
              next
            ),
        };
      },
    },
  };
};
