// Run-time module: deployed Functions import it through voke.config.ts.
import { dynamodbTable } from "@vokejs/aws/cloudformation";
import { VokeConfigError } from "voke";
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
 * The idempotency Plugin for `voke.config.ts`. It contributes a DynamoDB table, and runs every
 * handler in the scope `idempotent(...)` reads. A Function that uses `idempotent` or
 * `idempotentBatch` links the table like any resource: `resources: ["idempotencyTable"]`.
 */
export const idempotency = (
  options: IdempotencyPluginOptions = {}
): VokePlugin => {
  const table = options.table ?? defaultTable;
  const expiresAfterSeconds =
    options.expiresAfterSeconds ?? defaultExpiresAfterSeconds;

  assertExpiresAfterSeconds(expiresAfterSeconds, "idempotency()");

  // Each idempotent handler call reads the table name through its Function's
  // `context.resource`, so a Function that does not link the table fails before the store is
  // used. Synthesis, builds and tests that never call an idempotent handler need neither the
  // variable nor AWS.
  let tableName: string | undefined;
  const store =
    options.store ??
    dynamoDbStore({
      tableName: () => {
        if (tableName === undefined) {
          throw new VokeConfigError(
            `The idempotency table "${table}" was used before a Function read its binding`
          );
        }

        return tableName;
      },
    });

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
                ...(options.store === undefined
                  ? {
                      resolveTable: () => {
                        tableName = execution.context.resource(table);
                      },
                    }
                  : {}),
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
