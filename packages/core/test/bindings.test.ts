import { expect, test } from "bun:test";

import {
  bindResource,
  dynamodbTable,
  eventBus,
  s3Bucket,
  secret,
  snsTopic,
  sqsQueue,
  ssmParameter,
} from "../src/aws";
import { createResourceBindingName } from "../src/bindings";
import { synthesizeCloudFormation } from "../src/cloudformation";
import { createLocalResourceBindings } from "../src/local";

test("uses one stable binding naming convention everywhere", () => {
  expect(createResourceBindingName("ordersTable", "name")).toBe(
    "VOKE_RESOURCE_ORDERS_TABLE_NAME"
  );
  expect(createResourceBindingName("eventsQueue", "url")).toBe(
    "VOKE_RESOURCE_EVENTS_QUEUE_URL"
  );
  expect(createResourceBindingName("signingSecret", "id")).toBe(
    "VOKE_RESOURCE_SIGNING_SECRET_ID"
  );
  expect(bindResource("ordersTable", "name").envName).toBe(
    createResourceBindingName("ordersTable", "name")
  );
});

test("keeps synthesized and local resource bindings on the same logical contract", () => {
  const template = synthesizeCloudFormation({
    name: "binding-api",
    resources: {
      appSecret: secret(),
      eventsBus: eventBus(),
      eventsQueue: sqsQueue(),
      ordersTable: dynamodbTable({ partitionKey: "id" }),
      publicConfig: ssmParameter({ value: "enabled" }),
      uploadsBucket: s3Bucket(),
      userTopic: snsTopic(),
    },
  });
  const functionResource = template.Resources.Function;

  if (functionResource === undefined) {
    throw new Error("Expected synthesized function resource");
  }

  const synthesizedBindings = (
    functionResource.Properties as {
      Environment: { Variables: Record<string, unknown> };
    }
  ).Environment.Variables;
  const localBindings = createLocalResourceBindings(template, {
    accountId: "123456789012",
    endpoint: "http://localhost:4566",
    region: "sa-east-1",
  });

  expect(synthesizedBindings.VOKE_RESOURCE_ORDERS_TABLE_NAME).toEqual({
    Ref: "OrdersTable",
  });
  expect(synthesizedBindings.VOKE_RESOURCE_EVENTS_QUEUE_URL).toEqual({
    Ref: "EventsQueue",
  });
  expect(synthesizedBindings.VOKE_RESOURCE_USER_TOPIC_ARN).toEqual({
    Ref: "UserTopic",
  });
  expect(synthesizedBindings.VOKE_RESOURCE_APP_SECRET_ID).toEqual({
    "Fn::GetAtt": ["AppSecret", "Id"],
  });
  expect(Object.keys(localBindings).toSorted()).toEqual(
    Object.keys(synthesizedBindings)
      .filter((name) => name.startsWith("VOKE_RESOURCE_"))
      .toSorted()
  );
  expect(localBindings).toMatchObject({
    VOKE_RESOURCE_APP_SECRET_ID: "AppSecret",
    VOKE_RESOURCE_EVENTS_BUS_NAME: "EventsBus",
    VOKE_RESOURCE_EVENTS_QUEUE_URL:
      "http://localhost:4566/123456789012/EventsQueue",
    VOKE_RESOURCE_ORDERS_TABLE_NAME: "OrdersTable",
    VOKE_RESOURCE_PUBLIC_CONFIG_NAME: "PublicConfig",
    VOKE_RESOURCE_UPLOADS_BUCKET_NAME: "UploadsBucket",
    VOKE_RESOURCE_USER_TOPIC_ARN:
      "arn:aws:sns:sa-east-1:123456789012:UserTopic",
  });
});
