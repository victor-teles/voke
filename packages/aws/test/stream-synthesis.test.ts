import { expect, test } from "bun:test";

import { createFunctions, createVokeModel, fn, VokeConfigError } from "voke";
import type { StandardSchemaV1 } from "voke";

import {
  dynamodbTable,
  kinesisStream,
  sqsQueue,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import { aws, dynamodbStream, kinesis } from "../src/index";
import type { StreamEventSourceOptions } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

interface Statement {
  Action: string[];
  Effect: string;
  Resource: unknown;
}

interface Resource {
  Properties: Record<string, unknown> & {
    Policies?: { PolicyDocument: { Statement: Statement[] } }[];
  };
  Type: string;
}

const streamProject = (
  options: {
    clicks?: StreamEventSourceOptions;
    orders?: StreamEventSourceOptions;
  } = {}
) =>
  createFunctions({
    ingestClicks: kinesis({
      handler: (batch) => batch.ok(),
      record: schema<{ userId: string }>(),
      stream: "clicksStream",
      ...options.clicks,
    }),
    projectOrders: dynamodbStream({
      handler: (batch) => batch.ok(),
      item: schema<{ id: string }>(),
      table: "ordersTable",
      ...options.orders,
    }),
    report: fn({ handler: () => "ok", output: schema<string>() }),
  });

const streamResources = {
  clicksStream: kinesisStream(),
  ordersTable: dynamodbTable({ stream: "NEW_AND_OLD_IMAGES" }),
};

const synthesizeStreams = (functions = streamProject()) =>
  synthesizeCloudFormation({
    functions,
    name: "streams",
    resources: streamResources,
    stage: "test",
  }) as unknown as { Resources: Record<string, Resource> };

const roleStatements = (role: Resource | undefined): Statement[] =>
  (role?.Properties.Policies ?? []).flatMap(
    (policy) => policy.PolicyDocument.Statement
  );

const roleActions = (role: Resource | undefined): string[] =>
  roleStatements(role).flatMap((statement) => statement.Action);

const modelIssues = (
  functions: ReturnType<typeof createFunctions>,
  resources: Record<string, ReturnType<typeof kinesisStream>>
): string => {
  try {
    createVokeModel({ functions, name: "streams", provider: aws(), resources });
  } catch (error) {
    return String(error);
  }

  return "";
};

test("kinesisStream() is an on-demand stream by default", () => {
  expect(kinesisStream()).toMatchObject({
    actions: ["kinesis:PutRecord", "kinesis:PutRecords"],
    bindingAttribute: "name",
    cloudFormationType: "AWS::Kinesis::Stream",
    outputName: "Name",
    properties: { StreamModeDetails: { StreamMode: "ON_DEMAND" } },
  });
});

test("kinesisStream({ shardCount }) is a provisioned stream", () => {
  expect(
    kinesisStream({ retentionHours: 48, shardCount: 2 }).properties
  ).toEqual({
    RetentionPeriodHours: 48,
    ShardCount: 2,
    StreamModeDetails: { StreamMode: "PROVISIONED" },
  });
  expect(() => kinesisStream({ shardCount: 0 })).toThrow(VokeConfigError);
  expect(() => kinesisStream({ retentionHours: 12 })).toThrow(VokeConfigError);
});

test("dynamodbTable({ stream }) emits a StreamSpecification and is unchanged without it", () => {
  expect(dynamodbTable({ stream: "NEW_IMAGE" }).properties).toEqual({
    ...dynamodbTable().properties,
    StreamSpecification: { StreamViewType: "NEW_IMAGE" },
  });
  expect(Object.keys(dynamodbTable().properties)).toEqual([
    "AttributeDefinitions",
    "BillingMode",
    "KeySchema",
  ]);
});

test("matches the CloudFormation snapshot for stream event source mappings", async () => {
  const snapshot = await Bun.file(
    `${import.meta.dir}/fixtures/stream-event-sources-cloudformation.json`
  ).json();

  expect(synthesizeStreams()).toEqual(snapshot);
});

test("each stream mapping reports batch item failures, starts at trim horizon and retries until expiry", () => {
  const { Resources } = synthesizeStreams();

  for (const logicalId of [
    "IngestClicksFunctionClicksStreamEventSourceMapping",
    "ProjectOrdersFunctionOrdersTableEventSourceMapping",
  ]) {
    const mapping = Resources[logicalId];

    expect(mapping?.Type).toBe("AWS::Lambda::EventSourceMapping");
    expect(mapping?.Properties).toMatchObject({
      BatchSize: 100,
      BisectBatchOnFunctionError: true,
      Enabled: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumBatchingWindowInSeconds: 0,
      StartingPosition: "TRIM_HORIZON",
    });
    expect(mapping?.Properties).not.toHaveProperty("MaximumRetryAttempts");
  }

  expect(
    Resources.IngestClicksFunctionClicksStreamEventSourceMapping?.Properties
      .EventSourceArn
  ).toEqual({ "Fn::GetAtt": ["ClicksStream", "Arn"] });
  expect(
    Resources.ProjectOrdersFunctionOrdersTableEventSourceMapping?.Properties
      .EventSourceArn
  ).toEqual({ "Fn::GetAtt": ["OrdersTable", "StreamArn"] });
});

test("maxRetryAttempts and startingPosition reach the mapping", () => {
  const { Resources } = synthesizeStreams(
    streamProject({
      clicks: { maxRetryAttempts: 5, startingPosition: "latest" },
    })
  );

  expect(
    Resources.IngestClicksFunctionClicksStreamEventSourceMapping?.Properties
  ).toMatchObject({ MaximumRetryAttempts: 5, StartingPosition: "LATEST" });
});

test("stream-read permissions are on the consuming Function's role only", () => {
  const { Resources } = synthesizeStreams();
  const clicksRole = Resources.IngestClicksFunctionRole;
  const ordersRole = Resources.ProjectOrdersFunctionRole;
  const reportRole = Resources.ReportFunctionRole;

  expect(roleStatements(clicksRole)).toContainEqual({
    Action: [
      "kinesis:DescribeStream",
      "kinesis:DescribeStreamSummary",
      "kinesis:GetRecords",
      "kinesis:GetShardIterator",
      "kinesis:ListShards",
    ],
    Effect: "Allow",
    Resource: { "Fn::GetAtt": ["ClicksStream", "Arn"] },
  });
  expect(roleStatements(ordersRole)).toContainEqual({
    Action: [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ],
    Effect: "Allow",
    Resource: { "Fn::GetAtt": ["OrdersTable", "StreamArn"] },
  });
  expect(roleActions(clicksRole)).not.toContain("dynamodb:GetShardIterator");
  expect(roleActions(ordersRole)).not.toContain("kinesis:GetShardIterator");
  expect(roleActions(reportRole)).not.toContain("kinesis:GetRecords");
  expect(roleActions(reportRole)).not.toContain("dynamodb:GetRecords");
  expect(roleActions(reportRole)).not.toContain("dynamodb:ListStreams");
  // Producers of the stream still get the resource's own actions.
  expect(roleActions(reportRole)).toContain("kinesis:PutRecord");
});

test("the AWS Provider reports each stream authoring mistake with its path", () => {
  const consumers = createFunctions({
    ingestClicks: kinesis({
      batchSize: 0,
      handler: (batch) => batch.ok(),
      maxBatchingWindowSeconds: 301,
      maxRetryAttempts: -2,
      record: schema<unknown>(),
      stream: "ordersQueue",
    }),
    projectKeys: dynamodbStream({
      handler: (batch) => batch.ok(),
      item: schema<{ id: string }>(),
      table: "keysTable",
    }),
    projectOrders: dynamodbStream({
      handler: (batch) => batch.ok(),
      table: "plainTable",
    }),
  });
  const message = modelIssues(consumers, {
    keysTable: dynamodbTable({ stream: "KEYS_ONLY" }),
    ordersQueue: sqsQueue(),
    plainTable: dynamodbTable(),
  });

  expect(message).toContain(
    'functions.ingestClicks.eventSources.0.resource: Function "ingestClicks" Kinesis event source references resource "ordersQueue", but it is an "AWS::SQS::Queue" resource instead of an "AWS::Kinesis::Stream".'
  );
  expect(message).toContain(
    "functions.ingestClicks.eventSources.0.properties.batchSize:"
  );
  expect(message).toContain(
    "functions.ingestClicks.eventSources.0.properties.maxBatchingWindowSeconds:"
  );
  expect(message).toContain(
    "functions.ingestClicks.eventSources.0.properties.maxRetryAttempts:"
  );
  expect(message).toContain(
    'functions.projectOrders.eventSources.0.resource: Function "projectOrders" DynamoDB stream event source references table "plainTable", which has no stream; add stream: "NEW_AND_OLD_IMAGES" to dynamodbTable().'
  );
  expect(message).toContain(
    "functions.projectKeys.eventSources.0.properties.itemSchema:"
  );
});

test("synthesis without the AWS Provider still rejects a table without a stream", () => {
  expect(() =>
    synthesizeCloudFormation({
      functions: createFunctions({
        projectOrders: dynamodbStream({
          handler: (batch) => batch.ok(),
          table: "ordersTable",
        }),
      }),
      name: "streams",
      resources: { ordersTable: dynamodbTable() },
    })
  ).toThrow('add stream: "NEW_AND_OLD_IMAGES" to dynamodbTable()');
});

test('scope: "resources" keeps the stream and the table stream but no mapping', () => {
  const template = synthesizeCloudFormationFromModel(
    createVokeModel({
      functions: streamProject(),
      name: "streams",
      resources: streamResources,
    }),
    { scope: "resources" }
  );

  expect(Object.keys(template.Resources).toSorted()).toEqual([
    "ClicksStream",
    "OrdersTable",
  ]);
  expect(
    template.Resources.OrdersTable?.Properties.StreamSpecification
  ).toEqual({ StreamViewType: "NEW_AND_OLD_IMAGES" });
  expect(template.Outputs).toHaveProperty("ClicksStreamName");
});
