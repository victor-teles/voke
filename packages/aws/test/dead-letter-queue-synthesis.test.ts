import { expect, test } from "bun:test";

import { createFunctions, createVokeModel } from "voke";
import type { StandardSchemaV1, VokeConfigInput } from "voke";

import {
  dynamodbTable,
  kinesisStream,
  s3Bucket,
  snsTopic,
  sqsQueue,
} from "../src/cloudformation";
import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "../src/cloudformation-synthesis";
import { dataResourceChanges } from "../src/data-retention";
import {
  aws,
  dynamodbStream,
  eventBridge,
  kinesis,
  s3,
  schedule,
  sns,
  sqs,
} from "../src/index";
import { findReferenceCycle } from "./template-references";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

interface Statement {
  Action: string | string[];
  Effect: string;
  Resource: unknown;
}

const deadLetterArn = (logicalId: string) => ({
  "Fn::GetAtt": [logicalId, "Arn"],
});

const synthesize = (
  functions: ReturnType<typeof createFunctions>,
  resources: VokeConfigInput["resources"] = {},
  scope: "all" | "resources" = "all"
): CloudFormationTemplate =>
  synthesizeCloudFormationFromModel(
    createVokeModel({ functions, name: "dlq", provider: aws(), resources }),
    { scope }
  );

const roleStatements = (
  role: CloudFormationResource | undefined
): Statement[] => {
  const policies = (role?.Properties.Policies ?? []) as unknown as {
    PolicyDocument: { Statement: Statement[] };
  }[];

  return policies.flatMap((policy) => policy.PolicyDocument.Statement);
};

/** The roles with a statement that names `queueLogicalId`, and the statements themselves. */
const rolesSendingTo = (
  template: CloudFormationTemplate,
  queueLogicalId: string
): string[] =>
  Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === "AWS::IAM::Role")
    .filter(([, role]) =>
      roleStatements(role).some((statement) =>
        JSON.stringify(statement.Resource).includes(`"${queueLogicalId}"`)
      )
    )
    .map(([logicalId]) => logicalId);

const deadLetterQueueIds = (template: CloudFormationTemplate): string[] =>
  Object.keys(template.Resources).filter((logicalId) =>
    logicalId.endsWith("DeadLetterQueue")
  );

const consumer = (queue = "ordersQueue") =>
  sqs({
    handler: (batch) => batch.ok(),
    message: schema<{ id: string }>(),
    queue,
  });

// --- SQS -----------------------------------------------------------------------------------------

test("a consumed queue gets a dead-letter queue and a redrive policy after 5 receives", () => {
  const template = synthesize(createFunctions({ processOrder: consumer() }), {
    ordersQueue: sqsQueue(),
  });

  expect(template.Resources.OrdersQueueDeadLetterQueue).toEqual({
    Properties: { MessageRetentionPeriod: 1_209_600 },
    Type: "AWS::SQS::Queue",
  });
  expect(template.Resources.OrdersQueue?.Properties).toEqual({
    RedrivePolicy: {
      deadLetterTargetArn: deadLetterArn("OrdersQueueDeadLetterQueue"),
      maxReceiveCount: 5,
    },
    VisibilityTimeout: 90,
  });
});

test("sqsQueue({ deadLetterQueue: false }) keeps the queue without a redrive policy", () => {
  const template = synthesize(createFunctions({ processOrder: consumer() }), {
    ordersQueue: sqsQueue({ deadLetterQueue: false }),
  });

  expect(template.Resources.OrdersQueue?.Properties).toEqual({
    VisibilityTimeout: 90,
  });
  expect(deadLetterQueueIds(template)).toEqual([]);
});

test("sqsQueue({ deadLetterQueue: false }) is stored on the resource's AWS metadata", () => {
  const model = createVokeModel({
    name: "dlq",
    resources: { ordersQueue: sqsQueue({ deadLetterQueue: false }) },
  });

  expect(model.resources.ordersQueue?.provider?.aws?.properties).toEqual({
    bindingValue: "ref",
    cloudFormationType: "AWS::SQS::Queue",
    deadLetterQueue: false,
    outputName: "Url",
    policyResource: "getAttArn",
  });
});

test("a queue that no Function consumes is left alone", () => {
  const template = synthesize(createFunctions({}), {
    ordersQueue: sqsQueue(),
  });

  expect(template.Resources.OrdersQueue?.Properties).toEqual({});
  expect(deadLetterQueueIds(template)).toEqual([]);
});

test("two Functions consuming one queue share its one dead-letter queue", () => {
  const template = synthesize(
    createFunctions({ auditOrder: consumer(), processOrder: consumer() }),
    { ordersQueue: sqsQueue() }
  );

  expect(deadLetterQueueIds(template)).toEqual(["OrdersQueueDeadLetterQueue"]);
  expect(template.Resources.OrdersQueue?.Properties.RedrivePolicy).toEqual({
    deadLetterTargetArn: deadLetterArn("OrdersQueueDeadLetterQueue"),
    maxReceiveCount: 5,
  });
});

test("a Function consuming two queues gives each its own dead-letter queue", () => {
  const template = synthesize(
    createFunctions({
      processOrder: sqs({
        handler: (batch) => batch.ok(),
        message: schema<{ id: string }>(),
        queues: ["a", "b"],
      }),
    }),
    { a: sqsQueue(), b: sqsQueue() }
  );

  expect(deadLetterQueueIds(template).toSorted()).toEqual([
    "ADeadLetterQueue",
    "BDeadLetterQueue",
  ]);
});

test("a hand-written queue with its own RedrivePolicy keeps it and gets no dead-letter queue", () => {
  const redrivePolicy = {
    deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:mine",
    maxReceiveCount: 3,
  };
  const template = synthesize(createFunctions({ processOrder: consumer() }), {
    ordersQueue: {
      ...sqsQueue(),
      properties: { RedrivePolicy: redrivePolicy },
    },
  });

  expect(template.Resources.OrdersQueue?.Properties.RedrivePolicy).toEqual(
    redrivePolicy
  );
  expect(deadLetterQueueIds(template)).toEqual([]);
});

test("a hand-written FIFO queue gets a FIFO dead-letter queue", () => {
  const template = synthesize(createFunctions({ processOrder: consumer() }), {
    ordersQueue: { ...sqsQueue(), properties: { FifoQueue: true } },
  });

  expect(template.Resources.OrdersQueueDeadLetterQueue?.Properties).toEqual({
    FifoQueue: true,
    MessageRetentionPeriod: 1_209_600,
  });
});

test("a declared resource that takes the dead-letter queue's logical id fails synthesis", () => {
  expect(() =>
    synthesize(createFunctions({ processOrder: consumer() }), {
      ordersQueue: sqsQueue(),
      ordersQueueDeadLetterQueue: sqsQueue(),
    })
  ).toThrow(
    'Function "processOrder" needs the logical id "OrdersQueueDeadLetterQueue" for its dead-letter queue, but resource "ordersQueueDeadLetterQueue" already uses it. Rename the resource, or turn the dead-letter queue off with deadLetterQueue: false.'
  );
});

test("no Function role can send to or read an SQS queue's dead-letter queue", () => {
  const template = synthesize(createFunctions({ processOrder: consumer() }), {
    ordersQueue: sqsQueue(),
  });

  expect(rolesSendingTo(template, "OrdersQueueDeadLetterQueue")).toEqual([]);
});

// --- Kinesis and DynamoDB streams ----------------------------------------------------------------

const streamResources = {
  clicksStream: kinesisStream(),
  ordersTable: dynamodbTable({ stream: "NEW_AND_OLD_IMAGES" }),
};

const streamDefinitions = (options: {
  deadLetterQueue?: boolean;
  maxRetryAttempts?: number;
}) => ({
  ingestClicks: kinesis({
    handler: (batch) => batch.ok(),
    record: schema<{ userId: string }>(),
    stream: "clicksStream",
    ...options,
  }),
  projectOrders: dynamodbStream({
    handler: (batch) => batch.ok(),
    table: "ordersTable",
    ...options,
  }),
});

const streamFunctions = (options: Parameters<typeof streamDefinitions>[0]) =>
  createFunctions(streamDefinitions(options));

const streamMappings = {
  IngestClicksFunction: "IngestClicksFunctionClicksStreamEventSourceMapping",
  ProjectOrdersFunction: "ProjectOrdersFunctionOrdersTableEventSourceMapping",
} as const;

test("a stream mapping sends batches it gives up on to the Function's dead-letter queue after 10 retries", () => {
  const template = synthesize(streamFunctions({}), streamResources);

  for (const [lambda, mapping] of Object.entries(streamMappings)) {
    const queue = `${lambda}DeadLetterQueue`;

    expect(template.Resources[mapping]?.Properties).toMatchObject({
      BisectBatchOnFunctionError: true,
      DestinationConfig: {
        OnFailure: { Destination: deadLetterArn(queue) },
      },
      MaximumRetryAttempts: 10,
    });
    expect(template.Resources[queue]).toEqual({
      Properties: { MessageRetentionPeriod: 1_209_600 },
      Type: "AWS::SQS::Queue",
    });
    expect(rolesSendingTo(template, queue)).toEqual([`${lambda}Role`]);
    expect(roleStatements(template.Resources[`${lambda}Role`])).toContainEqual({
      Action: ["sqs:SendMessage"],
      Effect: "Allow",
      Resource: deadLetterArn(queue),
    });
  }
});

test("a stream with deadLetterQueue: false has no destination, no retry cap, no queue and no statement", () => {
  const template = synthesize(
    streamFunctions({ deadLetterQueue: false }),
    streamResources
  );

  for (const mapping of Object.values(streamMappings)) {
    expect(template.Resources[mapping]?.Properties).not.toHaveProperty(
      "DestinationConfig"
    );
    expect(template.Resources[mapping]?.Properties).not.toHaveProperty(
      "MaximumRetryAttempts"
    );
  }

  expect(deadLetterQueueIds(template)).toEqual([]);
  expect(JSON.stringify(template)).not.toContain("sqs:SendMessage");
});

test("a stream with deadLetterQueue: false keeps an explicit retry cap", () => {
  const template = synthesize(
    streamFunctions({ deadLetterQueue: false, maxRetryAttempts: 3 }),
    streamResources
  );

  for (const mapping of Object.values(streamMappings)) {
    expect(template.Resources[mapping]?.Properties.MaximumRetryAttempts).toBe(
      3
    );
    expect(template.Resources[mapping]?.Properties).not.toHaveProperty(
      "DestinationConfig"
    );
  }
});

test("maxRetryAttempts: -1 retries until expiry and still keeps the destination", () => {
  const template = synthesize(
    streamFunctions({ maxRetryAttempts: -1 }),
    streamResources
  );

  for (const [lambda, mapping] of Object.entries(streamMappings)) {
    expect(template.Resources[mapping]?.Properties).toMatchObject({
      DestinationConfig: {
        OnFailure: { Destination: deadLetterArn(`${lambda}DeadLetterQueue`) },
      },
      MaximumRetryAttempts: -1,
    });
  }
});

test("a non-boolean deadLetterQueue fails model validation at its path", () => {
  const build = () =>
    createVokeModel({
      functions: createFunctions({
        ingestClicks: kinesis({
          deadLetterQueue: "yes" as unknown as boolean,
          handler: (batch) => batch.ok(),
          record: schema<{ userId: string }>(),
          stream: "clicksStream",
        }),
      }),
      name: "dlq",
      provider: aws(),
      resources: streamResources,
    });

  expect(build).toThrow(
    'Function "ingestClicks" deadLetterQueue must be true or false, got "yes".'
  );
  expect(build).toThrow(
    "functions.ingestClicks.eventSources.0.properties.deadLetterQueue"
  );
});

// --- SNS, EventBridge, S3 and schedules ----------------------------------------------------------

const pushResources = { ordersTopic: snsTopic(), uploadsBucket: s3Bucket() };

const pushDefinitions = (options: { deadLetterQueue?: boolean } = {}) => ({
  imageUploaded: s3({ bucket: "uploadsBucket", handler: () => {}, ...options }),
  nightly: schedule({
    expression: "cron(0 3 * * ? *)",
    handler: () => {},
    ...options,
  }),
  orderCreated: sns({
    handler: () => {},
    message: schema<{ id: string }>(),
    topic: "ordersTopic",
    ...options,
  }),
  orderPaid: eventBridge({
    detail: schema<{ id: string }>(),
    handler: () => {},
    pattern: { source: ["orders"] },
    ...options,
  }),
});

const pushFunctions = (options: { deadLetterQueue?: boolean } = {}) =>
  createFunctions(pushDefinitions(options));

const pushLambdas = [
  "ImageUploadedFunction",
  "NightlyFunction",
  "OrderCreatedFunction",
  "OrderPaidFunction",
];

test("each push-source Function sends events it fails after Lambda's retries to its dead-letter queue", () => {
  const template = synthesize(pushFunctions(), pushResources);

  for (const lambda of pushLambdas) {
    const queue = `${lambda}DeadLetterQueue`;

    expect(template.Resources[queue]).toEqual({
      Properties: { MessageRetentionPeriod: 1_209_600 },
      Type: "AWS::SQS::Queue",
    });
    expect(template.Resources[`${lambda}EventInvokeConfig`]).toEqual({
      Properties: {
        DestinationConfig: {
          OnFailure: { Destination: deadLetterArn(queue) },
        },
        FunctionName: { Ref: lambda },
        Qualifier: "$LATEST",
      },
      Type: "AWS::Lambda::EventInvokeConfig",
    });

    const senders = rolesSendingTo(template, queue);

    expect(senders).toContain(`${lambda}Role`);
    expect(
      senders.filter((role) => role !== "VokeSchedulerRole").toSorted()
    ).toEqual([`${lambda}Role`]);
  }
});

test("a schedule also keeps invocations Scheduler could not deliver, through its shared role", () => {
  const template = synthesize(pushFunctions(), pushResources);
  const target = template.Resources.NightlyFunctionSchedule?.Properties
    .Target as Record<string, unknown>;

  expect(target.DeadLetterConfig).toEqual({
    Arn: deadLetterArn("NightlyFunctionDeadLetterQueue"),
  });
  expect(roleStatements(template.Resources.VokeSchedulerRole)).toEqual([
    {
      Action: "lambda:InvokeFunction",
      Effect: "Allow",
      Resource: [deadLetterArn("NightlyFunction")],
    },
    {
      Action: "sqs:SendMessage",
      Effect: "Allow",
      Resource: [deadLetterArn("NightlyFunctionDeadLetterQueue")],
    },
  ]);
});

test("push sources with deadLetterQueue: false add no queue, no invoke config and no statement", () => {
  const template = synthesize(
    pushFunctions({ deadLetterQueue: false }),
    pushResources
  );

  expect(deadLetterQueueIds(template)).toEqual([]);
  expect(
    Object.values(template.Resources).filter(
      (resource) => resource.Type === "AWS::Lambda::EventInvokeConfig"
    )
  ).toEqual([]);
  expect(JSON.stringify(template)).not.toContain("sqs:SendMessage");
  expect(template.Resources.NightlyFunctionSchedule?.Properties.Target).toEqual(
    expect.not.objectContaining({ DeadLetterConfig: expect.anything() })
  );
  expect(roleStatements(template.Resources.VokeSchedulerRole)).toHaveLength(1);
});

test("each push-source builder stores deadLetterQueue in its Event Source properties", () => {
  for (const [key, definition] of Object.entries(pushDefinitions())) {
    expect([key, definition.events[0]?.properties.deadLetterQueue]).toEqual([
      key,
      true,
    ]);
  }

  for (const [key, definition] of Object.entries(
    pushDefinitions({ deadLetterQueue: false })
  )) {
    expect([key, definition.events[0]?.properties.deadLetterQueue]).toEqual([
      key,
      false,
    ]);
  }
});

// --- Every source together -----------------------------------------------------------------------

const allFunctions = () =>
  createFunctions({
    ...pushDefinitions(),
    ...streamDefinitions({}),
    processOrder: consumer(),
  });

const allResources = {
  ...pushResources,
  ...streamResources,
  ordersQueue: sqsQueue(),
};

test("a template with every Event Source has one dead-letter queue per owner and no reference cycle", () => {
  const template = synthesize(allFunctions(), allResources);

  expect(deadLetterQueueIds(template).toSorted()).toEqual(
    [...pushLambdas, ...Object.keys(streamMappings), "OrdersQueue"]
      .map((owner) => `${owner}DeadLetterQueue`)
      .toSorted()
  );
  expect(findReferenceCycle(template)).toBeUndefined();
});

test("the resources-only template has no dead-letter queue and no redrive policy", () => {
  const template = synthesize(allFunctions(), allResources, "resources");

  expect(deadLetterQueueIds(template)).toEqual([]);
  expect(JSON.stringify(template)).not.toContain("RedrivePolicy");
  expect(JSON.stringify(template)).not.toContain("EventInvokeConfig");
});

test("dead-letter queues are not retained, so the data-loss pre-flight ignores them", () => {
  const template = synthesize(allFunctions(), allResources);

  for (const logicalId of deadLetterQueueIds(template)) {
    expect(template.Resources[logicalId]).not.toHaveProperty("DeletionPolicy");
    expect(template.Resources[logicalId]).not.toHaveProperty("Metadata");
  }

  expect(
    dataResourceChanges([
      {
        action: "Remove",
        logicalId: "OrdersQueueDeadLetterQueue",
        resourceType: "AWS::SQS::Queue",
      },
      {
        action: "Add",
        logicalId: "OrderCreatedFunctionDeadLetterQueue",
        resourceType: "AWS::SQS::Queue",
      },
      {
        action: "Modify",
        logicalId: "OrdersQueue",
        replacement: "False",
        resourceType: "AWS::SQS::Queue",
      },
    ])
  ).toEqual([]);
});
