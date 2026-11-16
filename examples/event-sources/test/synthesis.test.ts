import { expect, test } from "bun:test";

import {
  eventBus,
  s3Bucket,
  snsTopic,
  synthesizeCloudFormation,
} from "@voke/aws/cloudformation";

import { functions } from "../src/functions";

test("synthesizes one trigger per Event Source and one shared Scheduler role", () => {
  const template = synthesizeCloudFormation({
    functions,
    name: "event-sources",
    resources: {
      ordersBus: eventBus(),
      ordersTopic: snsTopic(),
      uploadsBucket: s3Bucket(),
    },
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
    "AWS::Events::Rule",
    "AWS::SNS::Subscription",
    "AWS::Scheduler::Schedule",
  ]);
  expect(template.Resources.VokeSchedulerRole?.Type).toBe("AWS::IAM::Role");
  // Each Function keeps the events it fails after Lambda's retries in its dead-letter queue.
  expect(
    Object.values(template.Resources).filter(
      ({ Type }) => Type === "AWS::Lambda::EventInvokeConfig"
    )
  ).toHaveLength(4);
  expect(
    template.Resources.UploadsBucket?.Properties.NotificationConfiguration
  ).toEqual({ EventBridgeConfiguration: { EventBridgeEnabled: true } });
});
