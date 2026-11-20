import { expect, test } from "bun:test";

import { synthesizeCloudFormation } from "@vokejs/aws/cloudformation";

import { functions } from "../src/functions";
import config from "../voke.config";

test("a consumed queue moves a message that keeps failing to its dead-letter queue", () => {
  const template = synthesizeCloudFormation({ ...config, functions });

  expect(template.Resources.OrdersQueue?.Properties.RedrivePolicy).toEqual({
    deadLetterTargetArn: {
      "Fn::GetAtt": ["OrdersQueueDeadLetterQueue", "Arn"],
    },
    maxReceiveCount: 5,
  });
});

test("synthesis fails clearly when the ordersQueue resource is not declared", () => {
  expect(() =>
    synthesizeCloudFormation({ functions, name: "sqs-events" })
  ).toThrow(
    'functions.processOrder.events.0.resource: "sqs" Event Source references resource "ordersQueue", but no matching resource is defined.'
  );
});
