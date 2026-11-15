// Run-time module. The DynamoDB client is imported on first use, so a cold start that never calls
// an idempotent handler does not load it. The Lambda Node.js runtime provides it (`@aws-sdk/*` is
// external in Voke builds).
import type {
  AttributeValue,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createAwsClientConfig } from "@voke/aws";
import type { AwsClientConfig } from "@voke/aws";

import type {
  IdempotencyAcquireResult,
  IdempotencyRecord,
  IdempotencyStore,
} from "./store";

export type DynamoDbStoreCommand =
  | DeleteItemCommand
  | GetItemCommand
  | PutItemCommand
  | UpdateItemCommand;

/** The part of `DynamoDBClient` the store uses. */
export interface DynamoDbStoreClient {
  send(command: DynamoDbStoreCommand): Promise<unknown>;
}

export interface DynamoDbStoreOptions {
  /** The table name, or a function that reads it on first use (such as a resource binding). */
  readonly tableName: string | (() => string);
  /** A client to use instead of `new DynamoDBClient(createAwsClientConfig())`. */
  readonly client?: DynamoDbStoreClient;
}

export interface DynamoDbStoreDependencies {
  /** Creates the client on first use when `client` is not given. */
  readonly createClient: (
    config: AwsClientConfig
  ) => Promise<DynamoDbStoreClient>;
}

type Item = Record<string, AttributeValue>;

const loadSdk = async () => await import("@aws-sdk/client-dynamodb");

const defaultDependencies: DynamoDbStoreDependencies = {
  createClient: async (config) => {
    const { DynamoDBClient } = await loadSdk();

    return new DynamoDBClient(config);
  },
};

// Every attribute goes through a name placeholder: `status` and `data` are DynamoDB reserved words.
const attributeNames = {
  "#data": "data",
  "#expiration": "expiration",
  "#id": "id",
  "#in_progress_expiration": "in_progress_expiration",
  "#status": "status",
} as const;

export const acquireCondition =
  "attribute_not_exists(#id) OR #expiration < :now OR (#status = :inprogress AND attribute_exists(#in_progress_expiration) AND #in_progress_expiration < :now_in_millis)";

const toItem = (record: IdempotencyRecord): Item => ({
  expiration: { N: String(record.expiresAt) },
  id: { S: record.id },
  status: { S: record.status },
  validation: { S: record.validation },
  ...(record.inProgressExpiresAt === undefined
    ? {}
    : { in_progress_expiration: { N: String(record.inProgressExpiresAt) } }),
  ...(record.data === undefined ? {} : { data: { S: record.data } }),
});

const malformedRecord = (field: string): Error =>
  new Error(
    `The idempotency table holds a record with a missing or invalid "${field}" attribute`
  );

const readString = (item: Item, field: string): string => {
  const value = item[field]?.S;

  if (value === undefined) {
    throw malformedRecord(field);
  }

  return value;
};

const readNumber = (item: Item, field: string): number | undefined => {
  const value = item[field]?.N;

  return value === undefined ? undefined : Number(value);
};

const fromItem = (item: Item): IdempotencyRecord => {
  const status = readString(item, "status");
  const expiresAt = readNumber(item, "expiration");
  const inProgressExpiresAt = readNumber(item, "in_progress_expiration");
  const data = item.data?.S;

  if (status !== "COMPLETED" && status !== "INPROGRESS") {
    throw malformedRecord("status");
  }

  if (expiresAt === undefined) {
    throw malformedRecord("expiration");
  }

  return {
    expiresAt,
    id: readString(item, "id"),
    status,
    validation: readString(item, "validation"),
    ...(inProgressExpiresAt === undefined ? {} : { inProgressExpiresAt }),
    ...(data === undefined ? {} : { data }),
  };
};

const isConditionalCheckFailure = (
  error: unknown
): error is Error & { Item?: Item } =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

const pick = <TKey extends keyof typeof attributeNames>(
  ...keys: TKey[]
): Record<TKey, (typeof attributeNames)[TKey]> =>
  Object.fromEntries(keys.map((key) => [key, attributeNames[key]])) as Record<
    TKey,
    (typeof attributeNames)[TKey]
  >;

/**
 * An Idempotency Store on a DynamoDB table with a string partition key `id`. Acquire is one
 * conditional `PutItem` that returns the blocking item (`ReturnValuesOnConditionCheckFailure`).
 */
export const dynamoDbStore = (
  options: DynamoDbStoreOptions,
  dependencies: Partial<DynamoDbStoreDependencies> = {}
): IdempotencyStore => {
  const deps = { ...defaultDependencies, ...dependencies };
  let tableName: string | undefined;
  let client: Promise<DynamoDbStoreClient> | undefined;

  const resolveTableName = (): string => {
    tableName ??=
      typeof options.tableName === "function"
        ? options.tableName()
        : options.tableName;

    return tableName;
  };

  const resolveClient = async (): Promise<DynamoDbStoreClient> => {
    client ??=
      options.client === undefined
        ? deps.createClient(createAwsClientConfig())
        : Promise.resolve(options.client);

    return await client;
  };

  // Reads the table name before the client, so a missing binding surfaces first and alone.
  const connect = async () => {
    const table = resolveTableName();
    const [sdk, dynamodb] = await Promise.all([loadSdk(), resolveClient()]);

    return { dynamodb, sdk, table };
  };

  const readExisting = async (id: string): Promise<Item | undefined> => {
    const { dynamodb, sdk, table } = await connect();
    const output = (await dynamodb.send(
      new sdk.GetItemCommand({
        ConsistentRead: true,
        Key: { id: { S: id } },
        TableName: table,
      })
    )) as { Item?: Item };

    return output.Item;
  };

  const put = async (
    record: IdempotencyRecord,
    now: number,
    attempt: number
  ): Promise<IdempotencyAcquireResult> => {
    const { dynamodb, sdk, table } = await connect();

    try {
      await dynamodb.send(
        new sdk.PutItemCommand({
          ConditionExpression: acquireCondition,
          ExpressionAttributeNames: pick(
            "#expiration",
            "#id",
            "#in_progress_expiration",
            "#status"
          ),
          ExpressionAttributeValues: {
            ":inprogress": { S: "INPROGRESS" },
            ":now": { N: String(Math.floor(now / 1000)) },
            ":now_in_millis": { N: String(now) },
          },
          Item: toItem(record),
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          TableName: table,
        })
      );

      return { acquired: true };
    } catch (error) {
      if (!isConditionalCheckFailure(error)) {
        throw error;
      }

      // Without the old item in the error, read it once; if it is gone, try the write again.
      const existing = error.Item ?? (await readExisting(record.id));

      if (existing !== undefined) {
        return { acquired: false, existing: fromItem(existing) };
      }

      if (attempt > 0) {
        throw error;
      }

      return await put(record, now, attempt + 1);
    }
  };

  return {
    acquire: async (record, now) => await put(record, now, 0),
    complete: async (id, data, expiresAt) => {
      const { dynamodb, sdk, table } = await connect();
      const setData = data === undefined ? "" : ", #data = :data";

      await dynamodb.send(
        new sdk.UpdateItemCommand({
          ExpressionAttributeNames: pick(
            "#expiration",
            "#in_progress_expiration",
            "#status",
            ...(data === undefined ? [] : (["#data"] as const))
          ),
          ExpressionAttributeValues: {
            ":completed": { S: "COMPLETED" },
            ":expiration": { N: String(expiresAt) },
            ...(data === undefined ? {} : { ":data": { S: data } }),
          },
          Key: { id: { S: id } },
          TableName: table,
          UpdateExpression: `SET #status = :completed, #expiration = :expiration${setData} REMOVE #in_progress_expiration`,
        })
      );
    },
    release: async (id) => {
      const { dynamodb, sdk, table } = await connect();

      await dynamodb.send(
        new sdk.DeleteItemCommand({ Key: { id: { S: id } }, TableName: table })
      );
    },
  };
};
