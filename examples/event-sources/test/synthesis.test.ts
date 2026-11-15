import { expect, test } from "bun:test";

import {
  eventBus,
  snsTopic,
  synthesizeCloudFormation,
} from "@voke/aws/cloudformation";

import { functions } from "../src/functions";

test("synthesizes one trigger per Event Source and one shared Scheduler role", () => {
  const template = synthesizeCloudFormation({
    functions,
    name: "event-sources",
    resources: { ordersBus: eventBus(), ordersTopic: snsTopic() },
  });
  const triggerTypes = Object.values(template.Resources)
    .map(({ Type }) => Type)
    .filter((type) =>
      [
        "AWS::Events::Rule",
        "AWS::SNS::Subscription",
        "AWS::Scheduler::Schedule",
      ].includes(type)
    )
    .toSorted();

  expect(triggerTypes).toEqual([
    "AWS::Events::Rule",
    "AWS::SNS::Subscription",
    "AWS::Scheduler::Schedule",
  ]);
  expect(template.Resources.VokeSchedulerRole?.Type).toBe("AWS::IAM::Role");
});
