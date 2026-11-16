import { expect, test } from "bun:test";

import { createVokeModel, defineConfig } from "voke";

import {
  dynamodbTable,
  eventBus,
  kinesisStream,
  s3Bucket,
  secret,
  snsTopic,
  sqsQueue,
  ssmParameter,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import type { CloudFormationResource } from "../src/cloudformation-template";
import { dataBearingTypes } from "../src/data-retention";
import { aws } from "../src/index";

const allBuilders = () => ({
  appSecret: secret(),
  clicksStream: kinesisStream(),
  eventsBus: eventBus(),
  eventsQueue: sqsQueue(),
  featureFlag: ssmParameter({ value: "on" }),
  notificationsTopic: snsTopic(),
  uploadsBucket: s3Bucket(),
  usersTable: dynamodbTable({ partitionKey: "id" }),
});

const retainedIds = ["AppSecret", "UploadsBucket", "UsersTable"];
const notRetainedIds = [
  "ClicksStream",
  "EventsBus",
  "EventsQueue",
  "FeatureFlag",
  "NotificationsTopic",
];

const modelFor = (stage: string) =>
  createVokeModel({ name: "shop", resources: allBuilders(), stage });

const expectRetained = (resource: CloudFormationResource | undefined) => {
  expect(resource?.DeletionPolicy).toBe("Retain");
  expect(resource?.UpdateReplacePolicy).toBe("Retain");
  expect(resource?.Metadata?.VokeRetain).toBe(true);
};

const expectNotRetained = (resource: CloudFormationResource | undefined) => {
  expect(resource).toBeDefined();
  expect(resource?.DeletionPolicy).toBeUndefined();
  expect(resource?.UpdateReplacePolicy).toBeUndefined();
  expect(resource?.Metadata?.VokeRetain).toBeUndefined();
};

test("tables, buckets and secrets are retained; queues, streams, topics, buses and parameters are not", () => {
  const template = synthesizeCloudFormation({
    name: "shop",
    resources: allBuilders(),
  });

  for (const id of retainedIds) {
    expectRetained(template.Resources[id]);
  }

  for (const id of notRetainedIds) {
    expectNotRetained(template.Resources[id]);
  }
});

test("retention is the default on every stage", () => {
  for (const stage of ["prod", "dev", "local"]) {
    const template = synthesizeCloudFormationFromModel(modelFor(stage));

    for (const id of retainedIds) {
      expectRetained(template.Resources[id]);
    }
  }
});

test("retainData: false emits no retention on any resource", () => {
  const template = synthesizeCloudFormationFromModel(modelFor("prod"), {
    retainData: false,
  });

  for (const id of [...retainedIds, ...notRetainedIds]) {
    expectNotRetained(template.Resources[id]);
  }
});

test("a retainData predicate sees each data-bearing resource and decides for it alone", () => {
  const seen: unknown[] = [];
  const template = synthesizeCloudFormationFromModel(modelFor("prod"), {
    retainData: (resource) => {
      seen.push(resource);

      return resource.key !== "uploadsBucket";
    },
  });

  expect(
    seen.toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    )
  ).toEqual([
    { key: "appSecret", stage: "prod", type: "AWS::SecretsManager::Secret" },
    { key: "uploadsBucket", stage: "prod", type: "AWS::S3::Bucket" },
    { key: "usersTable", stage: "prod", type: "AWS::DynamoDB::Table" },
  ]);
  expectRetained(template.Resources.UsersTable);
  expectRetained(template.Resources.AppSecret);
  expectNotRetained(template.Resources.UploadsBucket);
});

test("a raw resource definition passes through without retention, whatever its type", () => {
  const template = synthesizeCloudFormationFromModel(
    createVokeModel({
      name: "shop",
      resources: {
        legacyTable: {
          actions: ["dynamodb:GetItem"],
          bindingAttribute: "name",
          bindingValue: "ref",
          cloudFormationType: "AWS::DynamoDB::Table",
          outputName: "Name",
          policyResource: "getAttArn",
          properties: { BillingMode: "PAY_PER_REQUEST" },
        },
      },
      stage: "prod",
    })
  );

  expect(template.Resources.LegacyTable).toEqual({
    Metadata: {
      VokeBinding: { Attribute: "name", Resource: "legacyTable" },
    },
    Properties: { BillingMode: "PAY_PER_REQUEST" },
    Type: "AWS::DynamoDB::Table",
  });
});

const synthesizeWith = (provider: ReturnType<typeof aws>) => {
  const synthesize = provider.synthesis?.synthesize;

  if (synthesize === undefined) {
    throw new Error("aws() has no synthesis capability");
  }

  return synthesize({
    config: defineConfig({ name: "shop" }),
    model: modelFor("dev"),
  }) as { Resources: Record<string, CloudFormationResource> };
};

test("aws({ retainData }) reaches voke synth", () => {
  expectRetained(synthesizeWith(aws()).Resources.UsersTable);
  expectNotRetained(
    synthesizeWith(aws({ retainData: false })).Resources.UsersTable
  );
});

test("every builder marked data-bearing has its type in dataBearingTypes", () => {
  for (const definition of Object.values(allBuilders())) {
    const { properties } = definition.provider.aws;

    if (properties.dataBearing === true) {
      expect(dataBearingTypes.has(properties.cloudFormationType)).toBe(true);
    }
  }

  expect([...dataBearingTypes].toSorted()).toEqual([
    "AWS::DynamoDB::Table",
    "AWS::S3::Bucket",
    "AWS::SecretsManager::Secret",
  ]);
});
