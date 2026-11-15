import { expect, test } from "bun:test";

import { createFunctions, createVokeModel } from "voke";
import type { StandardSchemaV1 } from "voke";

import {
  eventBus,
  snsTopic,
  sqsQueue,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import { aws, eventBridge, schedule, sns } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const orderEvent = schema<{ orderId: string }>();

const eventSourceFunctions = () =>
  createFunctions({
    nightlyCleanup: schedule({
      expression: "cron(0 3 * * ? *)",
      handler: () => {},
      timezone: "America/Sao_Paulo",
    }),
    orderCreated: sns({
      filterPolicy: { type: ["created"] },
      handler: () => {},
      message: orderEvent,
      topic: "ordersTopic",
    }),
    orderPaid: eventBridge({
      bus: "ordersBus",
      detail: orderEvent,
      handler: () => {},
      pattern: {
        detail: { status: ["PAID"] },
        detailType: ["OrderPaid"],
        source: ["orders"],
      },
    }),
  });

const resources = { ordersBus: eventBus(), ordersTopic: snsTopic() };

test("matches the CloudFormation snapshot for SNS, EventBridge and schedule Event Sources", async () => {
  const template = synthesizeCloudFormation({
    functions: eventSourceFunctions(),
    name: "orders-events",
    resources,
    stage: "prod",
  });
  const snapshot = await Bun.file(
    `${import.meta.dir}/fixtures/event-sources-cloudformation.json`
  ).json();

  expect(template).toEqual(snapshot);
});

test("each wrong resource kind fails model validation with the resource it found", () => {
  const model = () =>
    createVokeModel({
      functions: createFunctions({
        onOrder: sns({
          handler: () => {},
          message: orderEvent,
          topic: "ordersQueue",
        }),
        onPaid: eventBridge({
          bus: "ordersQueue",
          detail: orderEvent,
          handler: () => {},
          pattern: { source: ["orders"] },
        }),
      }),
      name: "wrong-kinds",
      provider: aws(),
      resources: { ordersQueue: sqsQueue() },
    });

  expect(model).toThrow(
    'Function "onOrder" SNS event source references resource "ordersQueue", but it is an "AWS::SQS::Queue" resource instead of an "AWS::SNS::Topic".'
  );
  expect(model).toThrow(
    'Function "onPaid" EventBridge event source references resource "ordersQueue", but it is an "AWS::SQS::Queue" resource instead of an "AWS::Events::EventBus".'
  );
});

test("synthesis rejects a topic or bus of the wrong kind too", () => {
  expect(() =>
    synthesizeCloudFormation({
      functions: createFunctions({
        onOrder: sns({
          handler: () => {},
          message: orderEvent,
          topic: "ordersBus",
        }),
      }),
      name: "wrong-kinds",
      resources,
    })
  ).toThrow('instead of an "AWS::SNS::Topic"');
  expect(() =>
    synthesizeCloudFormation({
      functions: createFunctions({
        onPaid: eventBridge({
          bus: "ordersTopic",
          detail: orderEvent,
          handler: () => {},
          pattern: { source: ["orders"] },
        }),
      }),
      name: "wrong-kinds",
      resources,
    })
  ).toThrow('instead of an "AWS::Events::EventBus"');
});

test("two scheduled Functions share one Scheduler role that may invoke both", () => {
  const template = synthesizeCloudFormation({
    functions: createFunctions({
      hourly: schedule({
        expression: "rate(1 hour)",
        handler: () => {},
      }),
      nightly: schedule({
        enabled: false,
        expression: "cron(0 3 * * ? *)",
        handler: () => {},
      }),
    }),
    name: "jobs",
  });
  const roles = Object.entries(template.Resources).filter(
    ([, resource]) =>
      resource.Type === "AWS::IAM::Role" &&
      JSON.stringify(resource).includes("scheduler.amazonaws.com")
  );

  expect(roles.map(([logicalId]) => logicalId)).toEqual(["VokeSchedulerRole"]);
  expect(template.Resources.VokeSchedulerRole?.Properties.Policies).toEqual([
    {
      PolicyDocument: {
        Statement: [
          {
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
            Resource: [
              { "Fn::GetAtt": ["HourlyFunction", "Arn"] },
              { "Fn::GetAtt": ["NightlyFunction", "Arn"] },
            ],
          },
        ],
        Version: "2012-10-17",
      },
      PolicyName: "VokeInvokeScheduledFunctions",
    },
  ]);
  expect(template.Resources.HourlyFunctionSchedule?.Properties).toMatchObject({
    ScheduleExpressionTimezone: "UTC",
    State: "ENABLED",
  });
  expect(template.Resources.NightlyFunctionSchedule?.Properties.State).toBe(
    "DISABLED"
  );
});

test("a stack without scheduled Functions has no Scheduler role", () => {
  const template = synthesizeCloudFormation({
    functions: createFunctions({
      onOrder: sns({
        handler: () => {},
        message: orderEvent,
        topic: "ordersTopic",
      }),
    }),
    name: "no-schedules",
    resources,
  });

  expect(template.Resources.VokeSchedulerRole).toBeUndefined();
});

test("the resources-only template has no Function-side trigger resources", () => {
  const model = createVokeModel({
    functions: eventSourceFunctions(),
    name: "orders-events",
    provider: aws(),
    resources,
    stage: "local",
  });
  const template = synthesizeCloudFormationFromModel(model, {
    scope: "resources",
  });
  const types = Object.values(template.Resources).map(({ Type }) => Type);

  expect(Object.keys(template.Resources).toSorted()).toEqual([
    "OrdersBus",
    "OrdersTopic",
  ]);
  for (const type of [
    "AWS::SNS::Subscription",
    "AWS::Events::Rule",
    "AWS::Scheduler::Schedule",
    "AWS::Lambda::Permission",
    "AWS::IAM::Role",
  ]) {
    expect(types).not.toContain(type);
  }
});

test("an eventBridge() Function without a bus uses the default bus", () => {
  const template = synthesizeCloudFormation({
    functions: createFunctions({
      onPaid: eventBridge({
        detail: orderEvent,
        handler: () => {},
        pattern: { source: ["orders"] },
      }),
    }),
    name: "default-bus",
  });
  const rule = template.Resources.OnPaidFunctionDefaultBusRule;

  expect(rule?.Type).toBe("AWS::Events::Rule");
  expect(rule?.Properties).not.toHaveProperty("EventBusName");
  expect(rule?.Properties.EventPattern).toEqual({ source: ["orders"] });
  expect(
    template.Resources.OnPaidFunctionDefaultBusRulePermission?.Properties
  ).toEqual({
    Action: "lambda:InvokeFunction",
    FunctionName: { Ref: "OnPaidFunction" },
    Principal: "events.amazonaws.com",
    SourceArn: { "Fn::GetAtt": ["OnPaidFunctionDefaultBusRule", "Arn"] },
  });
});

test("an sns() Function keyed http gets bare, unique trigger logical ids", () => {
  const template = synthesizeCloudFormation({
    functions: createFunctions({
      http: sns({
        handler: () => {},
        message: orderEvent,
        topic: "ordersTopic",
      }),
      other: sns({
        handler: () => {},
        message: orderEvent,
        topic: "ordersTopic",
      }),
    }),
    name: "bare-ids",
    resources,
  });
  const triggerIds = Object.entries(template.Resources)
    .filter(([, { Type }]) =>
      ["AWS::Lambda::Permission", "AWS::SNS::Subscription"].includes(Type)
    )
    .map(([logicalId]) => logicalId)
    .toSorted();

  expect(triggerIds).toEqual([
    "FunctionOrdersTopicPermission",
    "FunctionOrdersTopicSubscription",
    "OtherFunctionOrdersTopicPermission",
    "OtherFunctionOrdersTopicSubscription",
  ]);
  expect(
    template.Resources.FunctionOrdersTopicSubscription?.Properties
  ).toEqual({
    Endpoint: { "Fn::GetAtt": ["Function", "Arn"] },
    Protocol: "lambda",
    TopicArn: { Ref: "OrdersTopic" },
  });
});
