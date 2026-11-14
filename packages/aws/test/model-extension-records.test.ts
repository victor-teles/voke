import { expect, test } from "bun:test";

import { createVokeModel } from "voke";

import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import { sqsQueue } from "../src/index";

test("AWS resource helpers store CloudFormation metadata as provider extension records", () => {
  const model = createVokeModel({
    name: "extension-records",
    resources: {
      ordersQueue: sqsQueue(),
    },
  });

  expect(model.resources.ordersQueue?.kind).toBe("resource");
  expect(model.resources.ordersQueue?.provider).toEqual({
    aws: {
      properties: {
        bindingValue: "ref",
        cloudFormationType: "AWS::SQS::Queue",
        outputName: "Url",
        policyResource: "getAttArn",
      },
      type: "cloudformation.resource",
    },
  });
});

test("AWS CloudFormation synthesis reads AWS resource extension records", () => {
  const model = createVokeModel({
    name: "extension-records",
    resources: {
      ordersQueue: sqsQueue(),
    },
  });
  const extension = model.resources.ordersQueue?.provider?.aws;

  if (extension === undefined) {
    throw new Error("missing AWS extension record");
  }

  extension.properties.outputName = "QueueUrlFromExtension";

  const template = synthesizeCloudFormationFromModel(model);

  expect(template.Resources.OrdersQueue).toMatchObject({
    Properties: {},
    Type: "AWS::SQS::Queue",
  });
  expect(template.Outputs.OrdersQueueQueueUrlFromExtension).toEqual({
    Description: "ordersQueue url",
    Value: { Ref: "OrdersQueue" },
  });
});
