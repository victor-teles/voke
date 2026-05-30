import { expect, test } from "bun:test";

import { synthesizeCloudFormation } from "../src/cloudformation";
import { dynamodbTable, sqsQueue } from "../src/index";
import { createStackTestContext } from "../src/testing";

test("resolves DynamoDB seed table names through resource bindings", () => {
  const template = synthesizeCloudFormation({
    name: "seed-api",
    resources: {
      emailsQueue: sqsQueue(),
      usersTable: dynamodbTable({ partitionKey: "id" }),
    },
  });
  const context = createStackTestContext({ template });
  const seedPlan = context.createSeedPlan({
    dynamodb: {
      usersTable: [{ active: true, id: "usr_1", score: 10 }],
    },
    sqs: {
      emailsQueue: [{ userId: "usr_1" }],
    },
  });

  expect(seedPlan.commands[0]).toEqual([
    "aws",
    "dynamodb",
    "put-item",
    "--table-name",
    "UsersTable",
    "--item",
    '{"active":{"BOOL":true},"id":{"S":"usr_1"},"score":{"N":"10"}}',
    "--region",
    "us-east-1",
  ]);
  expect(seedPlan.commands[1]?.at(4)).toBe(
    "http://localhost:4566/000000000000/EmailsQueue"
  );
});

test("rejects unsupported DynamoDB seed values instead of stringifying them", () => {
  const template = synthesizeCloudFormation({
    name: "seed-api",
    resources: {
      usersTable: dynamodbTable({ partitionKey: "id" }),
    },
  });
  const context = createStackTestContext({ template });

  expect(() =>
    context.createSeedPlan({
      dynamodb: {
        usersTable: [{ metadata: { role: "admin" } }],
      },
    })
  ).toThrow(
    'Unsupported DynamoDB seed attribute "metadata". Expected string, number, boolean, or null.'
  );
});
