import { expect, test } from "bun:test";

import { createFunctions, createVokeModel, fn } from "voke";
import type { StandardSchemaV1 } from "voke";

import {
  dynamodbTable,
  s3Bucket,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "../src/cloudformation";
import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import { aws, s3 } from "../src/index";
import { findReferenceCycle } from "./template-references";

const text: StandardSchemaV1<string, string> = {
  "~standard": {
    validate: (value) => ({ value: value as string }),
    vendor: "voke-test",
    version: 1,
  },
};

const s3Project = () =>
  createFunctions({
    imageDeleted: s3({
      bucket: "uploadsBucket",
      handler: () => {},
      on: ["deleted"],
    }),
    imageUploaded: s3({
      bucket: "uploadsBucket",
      handler: () => {},
      prefix: "incoming/",
      suffix: ".jpg",
    }),
    report: fn({ handler: () => "ok", output: text }),
  });

const s3Resources = { archiveBucket: s3Bucket(), uploadsBucket: s3Bucket() };

const s3Template = (): CloudFormationTemplate =>
  synthesizeCloudFormation({
    functions: s3Project(),
    name: "uploads",
    resources: s3Resources,
    stage: "prod",
  });

const resourcesOfType = (
  template: CloudFormationTemplate,
  type: string
): [string, CloudFormationResource][] =>
  Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === type
  );

test("matches the CloudFormation snapshot for S3 Event Sources", async () => {
  const snapshot = await Bun.file(
    `${import.meta.dir}/fixtures/s3-event-sources-cloudformation.json`
  ).json();

  expect(s3Template()).toEqual(snapshot);
});

test("the consumed bucket sends its events to EventBridge, once", () => {
  const template = s3Template();

  expect(template.Resources.UploadsBucket?.Properties).toEqual({
    NotificationConfiguration: {
      EventBridgeConfiguration: { EventBridgeEnabled: true },
    },
  });
});

test("a bucket no Function consumes has no NotificationConfiguration", () => {
  expect(s3Template().Resources.ArchiveBucket?.Properties).toEqual({});
});

test("each rule matches the S3 event kinds, the bucket by Ref and the key filter", () => {
  const rules = Object.fromEntries(
    resourcesOfType(s3Template(), "AWS::Events::Rule").map(([id, rule]) => [
      id,
      rule.Properties,
    ])
  );

  expect(rules).toEqual({
    ImageDeletedFunctionUploadsBucketRule: {
      EventPattern: {
        detail: { bucket: { name: [{ Ref: "UploadsBucket" }] } },
        "detail-type": ["Object Deleted"],
        source: ["aws.s3"],
      },
      State: "ENABLED",
      Targets: [
        {
          Arn: { "Fn::GetAtt": ["ImageDeletedFunction", "Arn"] },
          Id: "VokeFunction",
        },
      ],
    },
    ImageUploadedFunctionUploadsBucketRule: {
      EventPattern: {
        detail: {
          bucket: { name: [{ Ref: "UploadsBucket" }] },
          object: { key: [{ wildcard: "incoming/*.jpg" }] },
        },
        "detail-type": ["Object Created"],
        source: ["aws.s3"],
      },
      State: "ENABLED",
      Targets: [
        {
          Arn: { "Fn::GetAtt": ["ImageUploadedFunction", "Arn"] },
          Id: "VokeFunction",
        },
      ],
    },
  });
});

test("one Lambda permission per rule lets EventBridge invoke the Function", () => {
  const permissions = Object.fromEntries(
    resourcesOfType(s3Template(), "AWS::Lambda::Permission").map(
      ([id, permission]) => [id, permission.Properties]
    )
  );

  expect(permissions.ImageUploadedFunctionUploadsBucketRulePermission).toEqual({
    Action: "lambda:InvokeFunction",
    FunctionName: { Ref: "ImageUploadedFunction" },
    Principal: "events.amazonaws.com",
    SourceArn: {
      "Fn::GetAtt": ["ImageUploadedFunctionUploadsBucketRule", "Arn"],
    },
  });
  expect(permissions).toHaveProperty(
    "ImageDeletedFunctionUploadsBucketRulePermission"
  );
});

const keyMatcherOf = (
  options: { prefix?: string; suffix?: string } = {}
): unknown => {
  const template = synthesizeCloudFormation({
    functions: createFunctions({
      onUpload: s3({ bucket: "uploadsBucket", handler: () => {}, ...options }),
    }),
    name: "uploads",
    resources: s3Resources,
  });
  const [[, rule] = ["", undefined]] = resourcesOfType(
    template,
    "AWS::Events::Rule"
  );

  if (rule === undefined) {
    throw new Error("the template has no rule");
  }

  const pattern = rule.Properties.EventPattern as {
    detail: { object?: { key: unknown[] } };
  };

  return pattern.detail.object?.key;
};

test("the key matcher is prefix, suffix or an escaped wildcard for both", () => {
  expect(keyMatcherOf()).toBeUndefined();
  expect(keyMatcherOf({ prefix: "incoming/" })).toEqual([
    { prefix: "incoming/" },
  ]);
  expect(keyMatcherOf({ suffix: ".jpg" })).toEqual([{ suffix: ".jpg" }]);
  expect(keyMatcherOf({ prefix: "a*b\\c/", suffix: ".j*g" })).toEqual([
    { wildcard: "a\\*b\\\\c/*.j\\*g" },
  ]);
});

test("a wildcard pattern never has consecutive wildcards", () => {
  // A prefix ending in "*" is refused with a suffix; alone it is a plain prefix, with "*" literal.
  expect(keyMatcherOf({ prefix: "tmp*" })).toEqual([{ prefix: "tmp*" }]);
  expect(keyMatcherOf({ suffix: "*.bak" })).toEqual([{ suffix: "*.bak" }]);
  expect(() => keyMatcherOf({ prefix: "tmp*", suffix: ".bak" })).toThrow(
    "prefix cannot end with *"
  );
});

test("the template has no classic bucket notification to Lambda", () => {
  expect(JSON.stringify(s3Template())).not.toContain("LambdaConfigurations");
});

test("no resource depends on itself, directly or through other resources", () => {
  expect(findReferenceCycle(s3Template())).toBeUndefined();
});

test("the cycle helper finds a Bucket → Lambda → Role → Bucket cycle", () => {
  // Proves the helper would catch the classic notification wiring this design avoids.
  const template = s3Template();
  const classic: CloudFormationTemplate = {
    ...template,
    Resources: {
      ...template.Resources,
      UploadsBucket: {
        Properties: {
          NotificationConfiguration: {
            LambdaConfigurations: [
              {
                Event: "s3:ObjectCreated:*",
                Function: { "Fn::GetAtt": ["ImageUploadedFunction", "Arn"] },
              },
            ],
          },
        },
        Type: "AWS::S3::Bucket",
      },
    },
  };

  expect(findReferenceCycle(classic)).toEqual(
    expect.arrayContaining(["UploadsBucket", "ImageUploadedFunction"])
  );
});

test('scope: "resources" has no rule, no permission and no EventBridge flag', () => {
  const template = synthesizeCloudFormationFromModel(
    createVokeModel({
      functions: s3Project(),
      name: "uploads",
      resources: s3Resources,
    }),
    { scope: "resources" }
  );

  expect(Object.keys(template.Resources).toSorted()).toEqual([
    "ArchiveBucket",
    "UploadsBucket",
  ]);
  expect(template.Resources.UploadsBucket?.Properties).toEqual({});
});

test("the EventBridge flag merges into a NotificationConfiguration the bucket already has", () => {
  const model = createVokeModel({
    functions: s3Project(),
    name: "uploads",
    resources: s3Resources,
  });
  const { uploadsBucket } = model.resources;

  if (uploadsBucket === undefined) {
    throw new Error("uploadsBucket is missing from the model");
  }

  const template = synthesizeCloudFormationFromModel({
    ...model,
    resources: {
      ...model.resources,
      uploadsBucket: {
        ...uploadsBucket,
        properties: {
          NotificationConfiguration: {
            TopicConfigurations: [{ Event: "s3:ObjectCreated:*", Topic: "t" }],
          },
          VersioningConfiguration: { Status: "Enabled" },
        },
      },
    },
  });

  expect(template.Resources.UploadsBucket?.Properties).toEqual({
    NotificationConfiguration: {
      EventBridgeConfiguration: { EventBridgeEnabled: true },
      TopicConfigurations: [{ Event: "s3:ObjectCreated:*", Topic: "t" }],
    },
    VersioningConfiguration: { Status: "Enabled" },
  });
});

test("a bucket key that is not a bucket fails model validation", () => {
  expect(() =>
    createVokeModel({
      functions: createFunctions({
        onUpload: s3({ bucket: "ordersTable", handler: () => {} }),
      }),
      name: "uploads",
      provider: aws(),
      resources: { ordersTable: dynamodbTable() },
    })
  ).toThrow(
    'Function "onUpload" S3 event source references resource "ordersTable", but it is an "AWS::DynamoDB::Table" resource instead of an "AWS::S3::Bucket".'
  );
});

test("synthesis rejects a missing bucket too", () => {
  expect(() =>
    synthesizeCloudFormation({
      functions: createFunctions({
        onUpload: s3({ bucket: "missingBucket", handler: () => {} }),
      }),
      name: "uploads",
    })
  ).toThrow(
    'references resource "missingBucket", but no matching resource is defined.'
  );
});
