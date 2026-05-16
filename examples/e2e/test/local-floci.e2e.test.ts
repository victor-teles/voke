import { expect, test } from "bun:test";

import { createStackTestContext, synthesizeCloudFormation } from "voke";
import { dynamodbTable, sqsQueue } from "voke/aws";

test("prepares a Local Floci E2E context and seed plan", () => {
  const template = synthesizeCloudFormation({
    name: "e2e-api",
    resources: {
      emailsQueue: sqsQueue(),
      usersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });
  const context = createStackTestContext({ template });
  const seedPlan = context.createSeedPlan({
    dynamodb: {
      UsersTable: [{ email: "victor@example.com", id: "usr_1" }],
    },
    sqs: {
      EmailsQueue: [{ userId: "usr_1" }],
    },
  });

  expect(context.environment.VOKE_LOCAL_PROVIDER).toBe("floci");
  expect(seedPlan.commands).toHaveLength(2);
});
