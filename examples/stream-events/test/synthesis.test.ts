import { expect, test } from "bun:test";

import {
  dynamodbTable,
  synthesizeCloudFormation,
} from "@voke/aws/cloudformation";
import { createVokeModel } from "voke";

import { functions } from "../src/functions";
import config from "../voke.config";

test("each consumer gets a stream mapping with partial batch failure reporting", () => {
  const template = synthesizeCloudFormation({ ...config, functions });

  expect(
    template.Resources.ClicksFunctionClicksStreamEventSourceMapping?.Properties
  ).toMatchObject({
    EventSourceArn: { "Fn::GetAtt": ["ClicksStream", "Arn"] },
    FunctionResponseTypes: ["ReportBatchItemFailures"],
    StartingPosition: "TRIM_HORIZON",
  });
  expect(
    template.Resources.OrdersFunctionOrdersTableEventSourceMapping?.Properties
  ).toMatchObject({
    EventSourceArn: { "Fn::GetAtt": ["OrdersTable", "StreamArn"] },
    FunctionResponseTypes: ["ReportBatchItemFailures"],
  });
});

test("the AWS Provider rejects the orders consumer when the table has no stream", () => {
  expect(() =>
    createVokeModel({
      ...config,
      functions,
      resources: { ...config.resources, ordersTable: dynamodbTable() },
    })
  ).toThrow('add stream: "NEW_AND_OLD_IMAGES" to dynamodbTable()');
});
