import { expect, test } from "bun:test";

import {
  dynamodbTable,
  sqsQueue,
  synthesizeCloudFormation,
} from "@vokejs/aws/cloudformation";
import { floci } from "@vokejs/aws/local";
import { createStackTestContext } from "@vokejs/aws/testing";

test("prepares a Local Floci E2E context and seed plan", () => {
  const template = synthesizeCloudFormation({
    name: "e2e-api",
    resources: {
      emailsQueue: sqsQueue(),
      usersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });
  const context = createStackTestContext({ local: floci(), template });
  const deployedContext = createStackTestContext({
    outputs: {
      ApiUrl: "https://example.execute-api.us-east-1.amazonaws.com",
    },
    template,
  });
  const seedPlan = context.createSeedPlan({
    dynamodb: {
      UsersTable: [{ email: "victor@example.com", id: "usr_1" }],
    },
    sqs: {
      EmailsQueue: [{ userId: "usr_1" }],
    },
  });

  expect(context.environment.VOKE_LOCAL_PROVIDER).toBe("floci");
  expect(context.resource("emailsQueue", "url")).toBe(
    "http://localhost:4566/000000000000/EmailsQueue"
  );
  expect(context.resource("usersTable", "name")).toBe("UsersTable");
  expect(deployedContext.output("ApiUrl")).toBe(
    "https://example.execute-api.us-east-1.amazonaws.com"
  );
  expect(seedPlan.commands).toHaveLength(2);
  expect(seedPlan.commands[0]).toEqual([
    "aws",
    "dynamodb",
    "put-item",
    "--table-name",
    "UsersTable",
    "--item",
    '{"email":{"S":"victor@example.com"},"id":{"S":"usr_1"}}',
    "--region",
    "us-east-1",
  ]);
});
