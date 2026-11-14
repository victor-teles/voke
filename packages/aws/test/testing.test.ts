import { expect, test } from "bun:test";

import {
  dynamodbTable,
  sqsQueue,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import { floci } from "../src/local";
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

test("runs the stack context on the given Local AWS Provider", () => {
  const template = synthesizeCloudFormation({
    name: "seed-api",
    resources: {
      emailsQueue: sqsQueue(),
    },
  });
  const flociDefaults = floci();
  const context = createStackTestContext({
    local: {
      ...flociDefaults,
      environment: (options) => ({
        ...flociDefaults.environment(options),
        VOKE_LOCAL_PROVIDER: "custom-local-aws",
      }),
      name: "custom-local-aws",
    },
    template,
  });

  expect(context.environment.VOKE_LOCAL_PROVIDER).toBe("custom-local-aws");
  expect(
    createStackTestContext({ template }).environment.VOKE_LOCAL_PROVIDER
  ).toBe("floci");
});
