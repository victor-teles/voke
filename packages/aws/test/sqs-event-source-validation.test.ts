import { expect, test } from "bun:test";

import { createFunctions, createVokeModel } from "voke";

import { aws, dynamodbTable, sqs, sqsQueue } from "../src/index";

const messageSchema = {
  "~standard": {
    validate: (value: unknown) => ({ data: value, success: true as const }),
    vendor: "test",
    version: 1,
  },
} as const;

test("AWS provider validates SQS event sources against AWS queue resources", () => {
  const functions = createFunctions({
    processOrders: sqs({
      handler: (batch) => batch.ok(),
      message: messageSchema,
      queue: "ordersTable",
    }),
  });

  expect(() =>
    createVokeModel({
      functions,
      name: "invalid-aws-worker",
      provider: aws(),
      resources: {
        ordersTable: dynamodbTable(),
      },
    })
  ).toThrow(
    'Function "processOrders" SQS event source references resource "ordersTable", but it is an "AWS::DynamoDB::Table" resource instead of an "AWS::SQS::Queue".'
  );
});

test("core model validation still rejects missing SQS event source resources", () => {
  const functions = createFunctions({
    processOrders: sqs({
      handler: (batch) => batch.ok(),
      message: messageSchema,
      queue: "missingQueue",
    }),
  });

  expect(() =>
    createVokeModel({
      functions,
      name: "missing-resource-worker",
      provider: aws(),
      resources: {
        ordersQueue: sqsQueue(),
      },
    })
  ).toThrow(
    'SQS event source references resource "missingQueue", but no matching resource is defined.'
  );
});
