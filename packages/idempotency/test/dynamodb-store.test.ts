import { afterEach, beforeEach, expect, test } from "bun:test";

import { bindResource } from "@voke/aws";
import type { AwsClientConfig } from "@voke/aws";
import { VokeResourceBindingError } from "voke";

import { acquireCondition, dynamoDbStore } from "../src/dynamodb-store";
import type {
  DynamoDbStoreClient,
  DynamoDbStoreCommand,
} from "../src/dynamodb-store";
import type { IdempotencyRecord } from "../src/store";

interface SentCommand {
  readonly name: string;
  readonly input: unknown;
}

const conditionalCheckFailed = (item?: unknown): Error =>
  Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
    ...(item === undefined ? {} : { Item: item }),
  });

// Records each command; `replies` answers them in order (an Error rejects).
const fakeClient = (replies: unknown[] = []) => {
  const sent: SentCommand[] = [];
  const client: DynamoDbStoreClient = {
    send: (command: DynamoDbStoreCommand) => {
      sent.push({ input: command.input, name: command.constructor.name });
      const reply = replies.shift();

      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(reply ?? {});
    },
  };

  return { client, sent };
};

const now = Date.UTC(2026, 10, 15);

const record: IdempotencyRecord = {
  expiresAt: 1_763_168_400,
  id: "charge##abc",
  inProgressExpiresAt: now + 15_000,
  status: "INPROGRESS",
  validation: "v1",
};

const completedItem = {
  data: { S: '{"chargeId":"ch_1"}' },
  expiration: { N: "1763168400" },
  id: { S: "charge##abc" },
  status: { S: "COMPLETED" },
  validation: { S: "v1" },
};

const completedRecord: IdempotencyRecord = {
  data: '{"chargeId":"ch_1"}',
  expiresAt: 1_763_168_400,
  id: "charge##abc",
  status: "COMPLETED",
  validation: "v1",
};

const tableNameVariable = "VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME";
// Every variable a test below sets. Each is restored on its own: replacing process.env as a
// whole would detach it from Bun.env for every later test file in the same process.
const touchedVariables = [
  tableNameVariable,
  "AWS_REGION",
  "VOKE_AWS_ENDPOINT_URL",
] as const;
const savedValues = new Map(
  touchedVariables.map((name) => [name, process.env[name]])
);

beforeEach(() => {
  Reflect.deleteProperty(process.env, tableNameVariable);
});

afterEach(() => {
  for (const [name, value] of savedValues) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

test("acquire is one conditional PutItem that returns the old item on failure", async () => {
  const { client, sent } = fakeClient();
  const store = dynamoDbStore({ client, tableName: "dedupe" });

  await expect(store.acquire(record, now)).resolves.toEqual({
    acquired: true,
  });
  expect(sent).toEqual([
    {
      input: {
        ConditionExpression: acquireCondition,
        ExpressionAttributeNames: {
          "#expiration": "expiration",
          "#id": "id",
          "#in_progress_expiration": "in_progress_expiration",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":inprogress": { S: "INPROGRESS" },
          ":now": { N: String(now / 1000) },
          ":now_in_millis": { N: String(now) },
        },
        Item: {
          expiration: { N: "1763168400" },
          id: { S: "charge##abc" },
          in_progress_expiration: { N: String(now + 15_000) },
          status: { S: "INPROGRESS" },
          validation: { S: "v1" },
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        TableName: "dedupe",
      },
      name: "PutItemCommand",
    },
  ]);
  expect(acquireCondition).toBe(
    "attribute_not_exists(#id) OR #expiration < :now OR (#status = :inprogress AND attribute_exists(#in_progress_expiration) AND #in_progress_expiration < :now_in_millis)"
  );
});

test("a failed condition with the old item maps to the existing record", async () => {
  const { client, sent } = fakeClient([conditionalCheckFailed(completedItem)]);
  const store = dynamoDbStore({ client, tableName: "dedupe" });

  await expect(store.acquire(record, now)).resolves.toEqual({
    acquired: false,
    existing: completedRecord,
  });
  expect(sent.map((command) => command.name)).toEqual(["PutItemCommand"]);
});

test("a failed condition without the old item reads it once with a consistent read", async () => {
  const { client, sent } = fakeClient([
    conditionalCheckFailed(),
    { Item: completedItem },
  ]);
  const store = dynamoDbStore({ client, tableName: "dedupe" });

  await expect(store.acquire(record, now)).resolves.toEqual({
    acquired: false,
    existing: completedRecord,
  });
  expect(sent.at(1)).toEqual({
    input: {
      ConsistentRead: true,
      Key: { id: { S: "charge##abc" } },
      TableName: "dedupe",
    },
    name: "GetItemCommand",
  });
});

test("when the blocking item is gone by the read, the write is tried once more", async () => {
  const { client, sent } = fakeClient([conditionalCheckFailed(), {}, {}]);
  const store = dynamoDbStore({ client, tableName: "dedupe" });

  await expect(store.acquire(record, now)).resolves.toEqual({
    acquired: true,
  });
  expect(sent.map((command) => command.name)).toEqual([
    "PutItemCommand",
    "GetItemCommand",
    "PutItemCommand",
  ]);
});

test("other errors from PutItem are not swallowed", async () => {
  const throttled = Object.assign(new Error("slow down"), {
    name: "ProvisionedThroughputExceededException",
  });
  const { client } = fakeClient([throttled]);
  const store = dynamoDbStore({ client, tableName: "dedupe" });

  await expect(store.acquire(record, now)).rejects.toBe(throttled);
});

test("complete updates status, expiration and data with attribute name placeholders", async () => {
  const { client, sent } = fakeClient();
  const store = dynamoDbStore({ client, tableName: "dedupe" });

  await store.complete("charge##abc", '{"ok":true}', 1_763_168_500);
  await store.complete("charge##abc", undefined, 1_763_168_500);

  expect(sent).toEqual([
    {
      input: {
        ExpressionAttributeNames: {
          "#data": "data",
          "#expiration": "expiration",
          "#in_progress_expiration": "in_progress_expiration",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":completed": { S: "COMPLETED" },
          ":data": { S: '{"ok":true}' },
          ":expiration": { N: "1763168500" },
        },
        Key: { id: { S: "charge##abc" } },
        TableName: "dedupe",
        UpdateExpression:
          "SET #status = :completed, #expiration = :expiration, #data = :data REMOVE #in_progress_expiration",
      },
      name: "UpdateItemCommand",
    },
    {
      input: {
        ExpressionAttributeNames: {
          "#expiration": "expiration",
          "#in_progress_expiration": "in_progress_expiration",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":completed": { S: "COMPLETED" },
          ":expiration": { N: "1763168500" },
        },
        Key: { id: { S: "charge##abc" } },
        TableName: "dedupe",
        UpdateExpression:
          "SET #status = :completed, #expiration = :expiration REMOVE #in_progress_expiration",
      },
      name: "UpdateItemCommand",
    },
  ]);
});

test("release deletes the record", async () => {
  const { client, sent } = fakeClient();
  const store = dynamoDbStore({ client, tableName: "dedupe" });

  await store.release("charge##abc");

  expect(sent).toEqual([
    {
      input: { Key: { id: { S: "charge##abc" } }, TableName: "dedupe" },
      name: "DeleteItemCommand",
    },
  ]);
});

test("the client is created once, on first use, from createAwsClientConfig()", async () => {
  process.env.AWS_REGION = "eu-west-1";
  process.env.VOKE_AWS_ENDPOINT_URL = "https://127.0.0.1:9297";
  const configs: AwsClientConfig[] = [];
  const { client, sent } = fakeClient();
  const store = dynamoDbStore(
    { tableName: "dedupe" },
    {
      createClient: (config) => {
        configs.push(config);

        return Promise.resolve(client);
      },
    }
  );

  expect(configs).toEqual([]);

  await store.release("a");
  await store.release("b");

  expect(configs).toEqual([
    { endpoint: "https://127.0.0.1:9297", region: "eu-west-1" },
  ]);
  expect(sent).toHaveLength(2);
});

test("a missing table binding surfaces on first use, not when the store is created", async () => {
  const created: AwsClientConfig[] = [];
  const store = dynamoDbStore(
    {
      tableName: () => bindResource("idempotencyTable", "name").value(),
    },
    {
      createClient: (config) => {
        created.push(config);

        return Promise.resolve(fakeClient().client);
      },
    }
  );

  await expect(store.release("a")).rejects.toBeInstanceOf(
    VokeResourceBindingError
  );
  expect(created).toEqual([]);

  process.env.VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME = "orders-dev-idempotency";
  await expect(store.release("a")).resolves.toBeUndefined();
});
