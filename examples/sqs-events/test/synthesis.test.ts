import { expect, test } from "bun:test";

import { synthesizeCloudFormation } from "@voke/aws/cloudformation";

import { functions } from "../src/functions";

test("synthesis fails clearly when the ordersQueue resource is not declared", () => {
  expect(() =>
    synthesizeCloudFormation({ functions, name: "sqs-events" })
  ).toThrow(
    'functions.processOrder.events.0.resource: "sqs" Event Source references resource "ordersQueue", but no matching resource is defined.'
  );
});
