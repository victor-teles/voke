import { expect, test } from "bun:test";

import { runCli } from "../src/cli";
import {
  createServerlessMigration,
  parseServerlessYaml,
} from "../src/serverless-migration";

const serverlessYaml = `service: orders-api

provider:
  name: aws
  runtime: nodejs20.x
  stage: prod
  region: sa-east-1
  environment:
    LOG_LEVEL: info
  iamRoleStatements:
    - Effect: Allow
      Action:
        - dynamodb:GetItem
        - dynamodb:PutItem
      Resource: arn:aws:dynamodb:sa-east-1:123456789012:table/orders

package:
  patterns:
    - "!test/**"
    - "src/**"

plugins:
  - serverless-offline
  - serverless-webpack

functions:
  listOrders:
    handler: src/functions/list-orders.handler
    environment:
      TABLE_NAME: orders
    events:
      - httpApi:
          method: get
          path: /orders
      - http:
          method: post
          path: /orders
  fulfillOrder:
    handler: src/functions/fulfill-order.handler
    events:
      - sqs:
          arn: arn:aws:sqs:sa-east-1:123456789012:orders
      - eventBridge:
          eventBus: orders
          pattern:
            source:
              - orders
  scheduledReport:
    handler: src/functions/scheduled-report.handler
    events:
      - schedule: rate(1 day)
`;

const advancedServerlessYaml = `service: advanced-api

provider:
  name: aws
  runtime: nodejs22.x
  stage: \${opt:stage, 'dev'}
  region: \${self:custom.region}
  deploymentBucket:
    name: \${self:service}-deployments
  environment:
    SHARED_TABLE:
      Ref: UsersTable
    INLINE_LIST: [alpha, beta]
  iam:
    role:
      statements:
        - Effect: Allow
          Action: [sns:Publish, sqs:SendMessage]
          Resource:
            Fn::GetAtt: [OrdersTopic, Arn]
  tracing:
    lambda: true

package:
  patterns: ["!test/**", "src/**"]
  individually: true

plugins:
  - serverless-offline
  - serverless-esbuild

layers:
  shared:
    path: layers/shared

custom:
  region: us-east-1
  esbuild:
    bundle: true

resources:
  Resources:
    UsersTable:
      Type: AWS::DynamoDB::Table

functions:
  apiHandler:
    handler: src/api.handler
    runtime: nodejs24.x
    timeout: 15
    memorySize: 512
    layers:
      - { Ref: SharedLambdaLayer }
    package:
      patterns:
        - "!src/admin/**"
    environment:
      FUNCTION_TABLE: \${self:provider.environment.SHARED_TABLE}
    reservedConcurrency: 2
    events:
      - httpApi: "GET /profiles/{id}"
      - http:
          method: post
          path: /profiles
          cors: true
          authorizer:
            name: requestAuthorizer
          request:
            schemas:
              application/json: createProfileSchema
      - sns: arn:aws:sns:us-east-1:123456789012:profiles
      - sqs:
          arn:
            Fn::GetAtt: [OrdersQueue, Arn]
          batchSize: 10
      - eventBridge:
          eventBus: profiles
          pattern:
            source: [profiles]
      - s3:
          bucket: uploads
          event: s3:ObjectCreated:*
      - schedule:
          rate: rate(5 minutes)
          enabled: false
      - stream:
          type: dynamodb
          arn:
            Fn::GetAtt: [UsersTable, StreamArn]
      - kafka:
          arn: arn:aws:kafka:us-east-1:123456789012:cluster/orders

  kinesisWorker:
    handler: src/kinesis.handler
    events:
      - stream:
          type: kinesis
          arn: arn:aws:kinesis:us-east-1:123456789012:stream/orders

topLevelExperiment:
  enabled: true
`;
const deploymentBucketVariable = `\${self:service}-deployments`;
const functionTableVariable = `\${self:provider.environment.SHARED_TABLE}`;
const providerRegionVariable = `\${self:custom.region}`;
const providerStageVariable = `\${opt:stage, 'dev'}`;
const readServerlessMigrationFixture = (name: string): Promise<string> =>
  Bun.file(
    `${import.meta.dir}/../../../examples/serverless-migration/${name}/serverless.yml`
  ).text();

const pluginServerlessYaml = `service: plugin-api

provider:
  name: aws
  runtime: nodejs22.x
  stage: prod
  region: us-east-1

plugins:
  - serverless-offline
  - serverless-esbuild
  - serverless-webpack
  - serverless-plugin-typescript
  - serverless-dotenv-plugin
  - serverless-iam-roles-per-function
  - serverless-plugin-warmup
  - serverless-prune-plugin
  - serverless-domain-manager
  - serverless-plugin-datadog
  - serverless-plugin-aws-alerts
  - serverless-step-functions
  - serverless-appsync-plugin
  - serverless-custom-unknown

functions:
  ping:
    handler: src/ping.handler
    events:
      - httpApi:
          method: get
          path: /ping
`;

const resourceServerlessYaml = `service: resource-api

provider:
  name: aws
  runtime: nodejs22.x
  stage: prod
  region: us-east-1

resources:
  Resources:
    OrdersTable:
      Type: AWS::DynamoDB::Table
      Properties:
        BillingMode: PAY_PER_REQUEST
        KeySchema:
          - AttributeName: tenantId
            KeyType: HASH
          - AttributeName: orderId
            KeyType: RANGE
    OrdersQueue:
      Type: AWS::SQS::Queue
    EventsBus:
      Type: AWS::Events::EventBus
    UploadsBucket:
      Type: AWS::S3::Bucket
    ApiToken:
      Type: AWS::SecretsManager::Secret
    ConfigValue:
      Type: AWS::SSM::Parameter
      Properties:
        Type: String
        Value: enabled
    RetentionQueue:
      Type: AWS::SQS::Queue
      Properties:
        VisibilityTimeout: 30
    AuditLog:
      Type: AWS::Logs::LogGroup

functions:
  receiveOrder:
    handler: src/functions/receive-order.handler
    events:
      - httpApi:
          method: get
          path: /orders/{orderId}
`;

const sqsEventSourceServerlessYaml = `service: sqs-events-api

provider:
  name: aws
  runtime: nodejs22.x
  stage: prod
  region: us-east-1

resources:
  Resources:
    OrdersQueue:
      Type: AWS::SQS::Queue
    RetentionQueue:
      Type: AWS::SQS::Queue
      Properties:
        VisibilityTimeout: 30

functions:
  processOrder:
    handler: src/functions/process-order.handler
    events:
      - sqs:
          arn:
            Fn::GetAtt: [OrdersQueue, Arn]
          batchSize: 10
          maximumBatchingWindow: 20
          enabled: false
  inspectQueue:
    handler: src/functions/inspect-queue.handler
    events:
      - sqs:
          arn: arn:aws:sqs:us-east-1:123456789012:external-orders
  retryOrder:
    handler: src/functions/retry-order.handler
    events:
      - sqs:
          arn:
            Fn::GetAtt: [RetentionQueue, Arn]
`;

test("parses common Serverless Framework service shapes", () => {
  const service = parseServerlessYaml(serverlessYaml);

  expect(service.service).toBe("orders-api");
  expect(service.provider).toEqual({
    environment: {
      LOG_LEVEL: "info",
    },
    iamRoleStatements: [
      {
        Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
        Effect: "Allow",
        Resource: "arn:aws:dynamodb:sa-east-1:123456789012:table/orders",
      },
    ],
    name: "aws",
    region: "sa-east-1",
    runtime: "nodejs20.x",
    stage: "prod",
    unknownFields: [],
  });
  expect(service.package?.patterns).toEqual(["!test/**", "src/**"]);
  expect(service.unknownFields).toEqual([]);
  expect(service.plugins).toEqual(["serverless-offline", "serverless-webpack"]);
  expect(service.functions.listOrders?.events).toEqual([
    {
      method: "GET",
      path: "/orders",
      raw: { method: "get", path: "/orders" },
      type: "httpApi",
      unknownFields: [],
    },
    {
      method: "POST",
      path: "/orders",
      raw: { method: "post", path: "/orders" },
      type: "http",
      unknownFields: [],
    },
  ]);
  expect(service.functions.fulfillOrder?.events).toEqual([
    {
      arn: "arn:aws:sqs:sa-east-1:123456789012:orders",
      raw: { arn: "arn:aws:sqs:sa-east-1:123456789012:orders" },
      type: "sqs",
      unknownFields: [],
    },
    {
      eventBus: "orders",
      pattern: { source: ["orders"] },
      raw: { eventBus: "orders", pattern: { source: ["orders"] } },
      type: "eventBridge",
      unknownFields: [],
    },
  ]);
});

test("parses Phase 17 Serverless Framework coverage fixtures", () => {
  const service = parseServerlessYaml(advancedServerlessYaml);

  expect(service.service).toBe("advanced-api");
  expect(service.provider).toMatchObject({
    deploymentBucket: { name: deploymentBucketVariable },
    environment: {
      INLINE_LIST: "alpha,beta",
      SHARED_TABLE: "[object Object]",
    },
    iamRoleStatements: [
      {
        Action: ["sns:Publish", "sqs:SendMessage"],
        Effect: "Allow",
        Resource: {
          "Fn::GetAtt": ["OrdersTopic", "Arn"],
        },
      },
    ],
    name: "aws",
    region: providerRegionVariable,
    runtime: "nodejs22.x",
    stage: providerStageVariable,
  });
  expect(service.provider.unknownFields).toEqual([
    {
      path: "provider.tracing",
      reason: "provider field is not converted automatically",
      value: { lambda: true },
    },
  ]);
  expect(service.package).toEqual({
    individually: true,
    patterns: ["!test/**", "src/**"],
    raw: {
      individually: true,
      patterns: ["!test/**", "src/**"],
    },
    unknownFields: [],
  });
  expect(service.layers).toEqual({
    shared: { path: "layers/shared" },
  });
  expect(service.custom).toEqual({
    esbuild: { bundle: true },
    region: "us-east-1",
  });
  expect(service.resources).toEqual({
    Resources: {
      UsersTable: {
        Type: "AWS::DynamoDB::Table",
      },
    },
  });
  expect(service.unknownFields).toEqual([
    {
      path: "topLevelExperiment",
      reason: "root field is not converted automatically",
      value: { enabled: true },
    },
  ]);

  const { apiHandler } = service.functions;

  expect(apiHandler).toMatchObject({
    environment: {
      FUNCTION_TABLE: functionTableVariable,
    },
    handler: "src/api.handler",
    memorySize: 512,
    name: "apiHandler",
    runtime: "nodejs24.x",
    timeout: 15,
  });
  expect(apiHandler?.layers).toEqual([{ Ref: "SharedLambdaLayer" }]);
  expect(apiHandler?.package).toEqual({
    patterns: ["!src/admin/**"],
    raw: { patterns: ["!src/admin/**"] },
    unknownFields: [],
  });
  expect(apiHandler?.unknownFields).toEqual([
    {
      path: "functions.apiHandler.reservedConcurrency",
      reason: "function field is not converted automatically",
      value: 2,
    },
  ]);
  expect(apiHandler?.events).toEqual([
    {
      method: "GET",
      path: "/profiles/{id}",
      raw: "GET /profiles/{id}",
      type: "httpApi",
      unknownFields: [],
    },
    {
      authorizer: { name: "requestAuthorizer" },
      cors: true,
      method: "POST",
      path: "/profiles",
      raw: {
        authorizer: { name: "requestAuthorizer" },
        cors: true,
        method: "post",
        path: "/profiles",
        request: {
          schemas: {
            "application/json": "createProfileSchema",
          },
        },
      },
      type: "http",
      unknownFields: [
        {
          path: "functions.apiHandler.events[1].http.request",
          reason: "http event field is not converted automatically",
          value: {
            schemas: {
              "application/json": "createProfileSchema",
            },
          },
        },
      ],
    },
    {
      arn: "arn:aws:sns:us-east-1:123456789012:profiles",
      raw: "arn:aws:sns:us-east-1:123456789012:profiles",
      type: "sns",
      unknownFields: [],
    },
    {
      arn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
      batchSize: 10,
      raw: {
        arn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
        batchSize: 10,
      },
      type: "sqs",
      unknownFields: [],
    },
    {
      eventBus: "profiles",
      pattern: { source: ["profiles"] },
      raw: {
        eventBus: "profiles",
        pattern: { source: ["profiles"] },
      },
      type: "eventBridge",
      unknownFields: [],
    },
    {
      bucket: "uploads",
      event: "s3:ObjectCreated:*",
      raw: {
        bucket: "uploads",
        event: "s3:ObjectCreated:*",
      },
      type: "s3",
      unknownFields: [],
    },
    {
      enabled: false,
      rate: "rate(5 minutes)",
      raw: {
        enabled: false,
        rate: "rate(5 minutes)",
      },
      type: "schedule",
      unknownFields: [],
    },
    {
      arn: { "Fn::GetAtt": ["UsersTable", "StreamArn"] },
      raw: {
        arn: { "Fn::GetAtt": ["UsersTable", "StreamArn"] },
        type: "dynamodb",
      },
      streamType: "dynamodb",
      type: "stream",
      unknownFields: [],
    },
    {
      name: "kafka",
      type: "unsupported",
      value: {
        arn: "arn:aws:kafka:us-east-1:123456789012:cluster/orders",
      },
    },
  ]);
  expect(service.functions.kinesisWorker?.events).toEqual([
    {
      arn: "arn:aws:kinesis:us-east-1:123456789012:stream/orders",
      raw: {
        arn: "arn:aws:kinesis:us-east-1:123456789012:stream/orders",
        type: "kinesis",
      },
      streamType: "kinesis",
      type: "stream",
      unknownFields: [],
    },
  ]);
});

test("creates a measurable migration report and Voke skeleton files", () => {
  const migration = createServerlessMigration({
    outDirectory: "./voke-orders",
    source: serverlessYaml,
  });

  expect(migration.projectName).toBe("orders-api");
  expect(migration.files["./voke-orders/voke.config.ts"]).toContain(
    "defineConfig"
  );
  expect(migration.files["./voke-orders/voke.config.ts"]).toContain(
    "LOG_LEVEL"
  );
  expect(migration.files["./voke-orders/src/index.ts"]).toContain(
    "createGateway"
  );
  expect(migration.files["./voke-orders/src/index.ts"]).toContain(
    "defineFunctions"
  );
  expect(migration.files["./voke-orders/src/index.ts"]).toContain(
    "voke.config"
  );
  expect(migration.files["./voke-orders/src/routes/list-orders.ts"]).toContain(
    "createListOrdersRoutes"
  );
  expect(migration.files["./voke-orders/src/routes/list-orders.ts"]).toContain(
    'app.get("/orders"'
  );
  expect(migration.files["./voke-orders/src/routes/list-orders.ts"]).toContain(
    'method: "GET"'
  );
  expect(
    migration.files["./voke-orders/src/functions/fulfill-order.ts"]
  ).toContain("defineFunction");
  expect(
    migration.files["./voke-orders/src/functions/fulfill-order.ts"]
  ).toContain('entrypoint: "./src/functions/fulfill-order.ts"');
  expect(
    migration.files["./voke-orders/src/functions/fulfill-order.ts"]
  ).toContain('handler: "fulfillOrder.handler"');
  expect(migration.files["./voke-orders/src/functions/index.ts"]).toContain(
    "defineFunctions"
  );
  expect(migration.files["./voke-orders/voke.config.ts"]).toContain(
    'import { functions } from "./src/functions";'
  );
  expect(migration.files["./voke-orders/voke.config.ts"]).toContain(
    "functions,"
  );
  expect(migration.files["./voke-orders/src/stack.ts"]).toBeUndefined();
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "Unsupported features"
  );
  expect(
    migration.files["./voke-orders/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("HTTP API event");
  expect(
    migration.files["./voke-orders/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("SNS event");
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "## Unknown fields"
  );
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "`./voke-orders/src/functions/fulfill-order.ts`"
  );
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "Worker function skeleton for fulfillOrder."
  );
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "## Manual work by risk"
  );
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "| Area"
  );
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "Generated output"
  );
  expect(
    migration.files["./voke-orders/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("| Pattern");
  expect(
    migration.files["./voke-orders/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("Manual work");
  expect(migration.report.generatedFiles).toContainEqual({
    confidence: "medium",
    path: "./voke-orders/src/functions/fulfill-order.ts",
    purpose: "Worker function skeleton for fulfillOrder.",
  });
  expect(migration.report.converted).not.toContainEqual({
    area: "events",
    confidence: "medium",
    file: "./voke-orders/src/functions/fulfill-order.ts",
    message: "SQS worker skeleton is generated for fulfillOrder.",
  });
  expect(
    migration.report.manualTasks.some((task) => task.risk === "high")
  ).toBe(true);
  expect(migration.report.supported).toEqual([
    "service name",
    "provider stage",
    "provider region",
    "provider environment",
    "provider IAM statements",
    "package patterns",
    "plugins inventory",
    "HTTP API event: listOrders GET /orders",
    "REST API event: listOrders POST /orders",
    "EventBridge event: fulfillOrder",
    "Schedule event inventory: scheduledReport",
  ]);
  expect(migration.report.unsupported).toEqual([
    "plugin serverless-webpack maps to Voke Bun build but requires bundler option review",
    "sqs event on fulfillOrder requires manual implementation. Queue source cannot be resolved to a migrated Voke SQS queue resource.",
    "schedule event on scheduledReport requires manual implementation. Scheduled triggers require EventBridge rule infrastructure that must be reviewed before migration.",
  ]);
  expect(migration.report.manualSteps).toContain(
    "Move one Serverless function at a time by routing migrated HTTP paths to Voke while the original service keeps the remaining functions."
  );
});

test("matches stable Serverless migration report snapshots", async () => {
  const migration = createServerlessMigration({
    outDirectory: "./voke-orders",
    source: serverlessYaml,
  });
  const migrationReport = await Bun.file(
    `${import.meta.dir}/fixtures/serverless-migration-report.md`
  ).text();
  const compatibilityReport = await Bun.file(
    `${import.meta.dir}/fixtures/serverless-compatibility-report.md`
  ).text();

  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toBe(
    migrationReport
  );
  expect(migration.files["./voke-orders/SERVERLESS_COMPATIBILITY.md"]).toBe(
    compatibilityReport
  );
});

test("reports expanded event coverage and unknown fields deterministically", () => {
  const migration = createServerlessMigration({
    outDirectory: "./voke-advanced",
    source: advancedServerlessYaml,
  });

  expect(migration.report.supported).toEqual([
    "service name",
    "provider stage",
    "provider region",
    "provider environment",
    "provider IAM statements",
    "provider deployment bucket",
    "package patterns",
    "package individually flag",
    "plugins inventory",
    "layers inventory",
    "custom fields inventory",
    "resources inventory",
    "CloudFormation resource: UsersTable AWS::DynamoDB::Table",
    "HTTP API event: apiHandler GET /profiles/{id}",
    "REST API event: apiHandler POST /profiles",
    "SNS event inventory: apiHandler",
    "EventBridge event: apiHandler",
    "S3 event inventory: apiHandler",
    "Schedule event inventory: apiHandler",
    "Stream event inventory: apiHandler",
    "Stream event inventory: kinesisWorker",
  ]);
  expect(migration.report.unsupported).toEqual([
    "plugin serverless-esbuild maps to Voke Bun build but requires bundler option review",
    "sns event on apiHandler requires manual implementation. SNS subscriptions and publish/subscribe permissions are inventory-only in this migration phase.",
    "sqs event on apiHandler requires manual implementation. Queue source OrdersQueue is not generated as a Voke SQS queue resource.",
    "s3 event on apiHandler requires manual implementation. S3 notifications require bucket notification wiring and permissions that Voke does not generate in this migration phase.",
    "schedule event on apiHandler requires manual implementation. Scheduled triggers require EventBridge rule infrastructure that must be reviewed before migration.",
    "stream event on apiHandler requires manual implementation. Stream event source mappings need batching, starting position, and source permissions reviewed manually.",
    "Unsupported Serverless event kafka on function apiHandler: kafka is not an automatic Voke migration target. Recreate the trigger, permissions, batching, and failure behavior manually before cutting over.",
    "stream event on kinesisWorker requires manual implementation. Stream event source mappings need batching, starting position, and source permissions reviewed manually.",
  ]);
  expect(migration.report.unknownFields).toEqual([
    {
      path: "topLevelExperiment",
      reason: "root field is not converted automatically",
      value: { enabled: true },
    },
    {
      path: "provider.tracing",
      reason: "provider field is not converted automatically",
      value: { lambda: true },
    },
    {
      path: "functions.apiHandler.reservedConcurrency",
      reason: "function field is not converted automatically",
      value: 2,
    },
    {
      path: "functions.apiHandler.events[1].http.request",
      reason: "http event field is not converted automatically",
      value: {
        schemas: {
          "application/json": "createProfileSchema",
        },
      },
    },
  ]);
  expect(
    migration.files["./voke-advanced/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("Stream event");
  expect(
    migration.files["./voke-advanced/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("Inventory only");
  expect(migration.files["./voke-advanced/voke.config.ts"]).toContain(
    'import { dynamodbTable } from "voke/aws";'
  );
  expect(migration.files["./voke-advanced/voke.config.ts"]).toContain(
    '"UsersTable": dynamodbTable()'
  );
  expect(
    migration.files["./voke-advanced/src/routes/api-handler.ts"]
  ).toContain('app.get("/profiles/:id"');
  expect(
    migration.files["./voke-advanced/src/functions/api-handler.ts"]
  ).toContain('runtime: "nodejs24.x"');
  expect(migration.files["./voke-advanced/MIGRATION_REPORT.md"]).toContain(
    "Queue source OrdersQueue is not generated as a Voke SQS queue resource."
  );
  expect(migration.files["./voke-advanced/MIGRATION_REPORT.md"]).toContain(
    '"Fn::GetAtt": ['
  );
  expect(migration.files["./voke-advanced/src/stack.ts"]).toBeUndefined();
});

test("generates config-first resources and preserves unsafe resources as manual work", () => {
  const migration = createServerlessMigration({
    outDirectory: "./voke-resources",
    source: resourceServerlessYaml,
  });
  const config = migration.files["./voke-resources/voke.config.ts"];
  const route = migration.files["./voke-resources/src/routes/receive-order.ts"];
  const report = migration.files["./voke-resources/MIGRATION_REPORT.md"];

  expect(config).toContain(
    'import { dynamodbTable, eventBus, s3Bucket, secret, sqsQueue, ssmParameter } from "voke/aws";'
  );
  expect(config).toContain(
    '"OrdersTable": dynamodbTable({ partitionKey: "tenantId", sortKey: "orderId", billingMode: "PAY_PER_REQUEST" })'
  );
  expect(config).toContain('"OrdersQueue": sqsQueue()');
  expect(config).toContain('"EventsBus": eventBus()');
  expect(config).toContain('"UploadsBucket": s3Bucket()');
  expect(config).toContain('"ApiToken": secret()');
  expect(config).toContain(
    '"ConfigValue": ssmParameter({ value: "enabled", type: "String" })'
  );
  expect(config).not.toContain("RetentionQueue");
  expect(config).not.toContain("AuditLog");
  expect(route).toContain('app.get("/orders/:orderId"');
  expect(report).toContain(
    "CloudFormation resource RetentionQueue (AWS::SQS::Queue) requires manual migration"
  );
  expect(report).toContain(
    "CloudFormation resource AuditLog (AWS::Logs::LogGroup) requires manual migration"
  );
  expect(migration.report.unsupported).toContain(
    "CloudFormation resource AuditLog (AWS::Logs::LogGroup) requires manual migration because Voke cannot safely generate an equivalent config helper."
  );
  expect(migration.files["./voke-resources/src/stack.ts"]).toBeUndefined();
});

test("generates first-class SQS Event Sources for resolvable queues and reports manual queue gaps", () => {
  const migration = createServerlessMigration({
    outDirectory: "./voke-sqs-events",
    source: sqsEventSourceServerlessYaml,
  });
  const processOrder =
    migration.files["./voke-sqs-events/src/functions/process-order.ts"];
  const inspectQueue =
    migration.files["./voke-sqs-events/src/functions/inspect-queue.ts"];
  const retryOrder =
    migration.files["./voke-sqs-events/src/functions/retry-order.ts"];
  const report = migration.files["./voke-sqs-events/MIGRATION_REPORT.md"];
  const compatibility =
    migration.files["./voke-sqs-events/SERVERLESS_COMPATIBILITY.md"];

  expect(processOrder).toContain(
    'import { defineFunction, sqsEventSource, sqsMessageBatch } from "voke";'
  );
  expect(processOrder).toContain(
    'events: [sqsEventSource("OrdersQueue", { batchSize: 10, enabled: false, maxBatchingWindowSeconds: 20 })],'
  );
  expect(processOrder).toContain("input: sqsMessageBatch(messageSchema)");
  expect(processOrder).toContain("return payload.ok();");
  expect(inspectQueue).toContain('import { defineFunction } from "voke";');
  expect(inspectQueue).not.toContain("sqsEventSource(");
  expect(retryOrder).not.toContain("sqsEventSource(");
  expect(migration.report.supported).toContain(
    "SQS Event Source: processOrder -> OrdersQueue"
  );
  expect(migration.report.unsupported).toContain(
    "sqs event on inspectQueue requires manual implementation. Queue source cannot be resolved to a migrated Voke SQS queue resource."
  );
  expect(migration.report.unsupported).toContain(
    "sqs event on retryOrder requires manual implementation. Queue source RetentionQueue is not generated as a Voke SQS queue resource."
  );
  expect(report).toContain("SQS Event Source processOrder -> OrdersQueue");
  expect(report).toContain(
    "Queue source cannot be resolved to a migrated Voke SQS queue resource."
  );
  expect(compatibility).toContain("SQS Event Source");
  expect(compatibility).toContain("Supported");
  expect(compatibility).toContain(
    "sqs event on inspectQueue requires manual implementation."
  );
});

test("generates skeletons from example Serverless migration fixtures", async () => {
  const httpApi = createServerlessMigration({
    outDirectory: "./voke-http-api",
    source: await readServerlessMigrationFixture("http-api"),
  });
  const restApi = createServerlessMigration({
    outDirectory: "./voke-rest-api",
    source: await readServerlessMigrationFixture("rest-api"),
  });
  const sqsWorker = createServerlessMigration({
    outDirectory: "./voke-sqs-worker",
    source: await readServerlessMigrationFixture("sqs-worker"),
  });
  const eventBridgeWorker = createServerlessMigration({
    outDirectory: "./voke-eventbridge-worker",
    source: await readServerlessMigrationFixture("eventbridge-worker"),
  });

  expect(httpApi.files["./voke-http-api/src/routes/get-profile.ts"]).toContain(
    'app.get("/profiles/:id"'
  );
  expect(restApi.files["./voke-rest-api/src/routes/create-user.ts"]).toContain(
    'app.post("/users"'
  );
  expect(
    sqsWorker.files["./voke-sqs-worker/src/functions/process-order.ts"]
  ).toContain('entrypoint: "./src/functions/process-order.ts"');
  expect(
    sqsWorker.files["./voke-sqs-worker/src/functions/process-order.ts"]
  ).toContain('events: [sqsEventSource("OrdersQueue")],');
  expect(
    sqsWorker.files["./voke-sqs-worker/src/functions/process-order.ts"]
  ).toContain("input: sqsMessageBatch(messageSchema)");
  expect(sqsWorker.files["./voke-sqs-worker/src/functions/index.ts"]).toContain(
    '"processOrder": processOrder'
  );
  expect(
    eventBridgeWorker.files[
      "./voke-eventbridge-worker/src/functions/sync-customer.ts"
    ]
  ).toContain('eventTypes: ["eventBridge"]');
  expect(
    eventBridgeWorker.files["./voke-eventbridge-worker/voke.config.ts"]
  ).toContain("functions,");
  expect(httpApi.files["./voke-http-api/src/stack.ts"]).toBeUndefined();
  expect(restApi.files["./voke-rest-api/src/stack.ts"]).toBeUndefined();
  expect(sqsWorker.files["./voke-sqs-worker/src/stack.ts"]).toBeUndefined();
  expect(
    eventBridgeWorker.files["./voke-eventbridge-worker/src/stack.ts"]
  ).toBeUndefined();
});

test("reports Serverless Framework plugin compatibility deterministically", () => {
  const migration = createServerlessMigration({
    outDirectory: "./voke-plugins",
    source: pluginServerlessYaml,
  });

  expect(migration.service.plugins).toEqual([
    "serverless-offline",
    "serverless-esbuild",
    "serverless-webpack",
    "serverless-plugin-typescript",
    "serverless-dotenv-plugin",
    "serverless-iam-roles-per-function",
    "serverless-plugin-warmup",
    "serverless-prune-plugin",
    "serverless-domain-manager",
    "serverless-plugin-datadog",
    "serverless-plugin-aws-alerts",
    "serverless-step-functions",
    "serverless-appsync-plugin",
    "serverless-custom-unknown",
  ]);
  expect(migration.report.pluginCompatibility).toEqual([
    {
      manualSteps: [],
      mappedBehavior:
        "Use `voke dev` for local API feedback and `voke local start` for the configured local AWS provider.",
      name: "serverless-offline",
      notes: [
        "Voke does not run the Serverless Offline plugin, but the stable local workflow covers the same development loop.",
      ],
      status: "supported",
      summary:
        "Local development workflow is covered by Voke dev/local commands.",
    },
    {
      manualSteps: [
        "Review `custom.esbuild` options and port any required aliases, loaders, externals, or minification settings into the Voke build workflow.",
      ],
      mappedBehavior:
        "Generated projects use `voke build`, which bundles with Bun.",
      name: "serverless-esbuild",
      notes: [
        "Voke uses Bun for builds, so Serverless esbuild plugin execution is not carried forward.",
      ],
      status: "mapped",
      summary: "Build behavior maps to the Voke Bun build pipeline.",
    },
    {
      manualSteps: [
        "Review `custom.webpack` options and port any required aliases, loaders, externals, or minification settings into the Voke build workflow.",
      ],
      mappedBehavior:
        "Generated projects use `voke build`, which bundles with Bun.",
      name: "serverless-webpack",
      notes: [
        "Voke uses Bun for builds, so Webpack plugin execution is not carried forward.",
      ],
      status: "mapped",
      summary: "Build behavior maps to the Voke Bun build pipeline.",
    },
    {
      manualSteps: [
        "Review TypeScript build hooks and generated artifacts; Voke expects source-first Bun builds and explicit handler exports.",
      ],
      mappedBehavior:
        "Generated projects use TypeScript source files with `voke build` and `bunx tsgo` typechecking.",
      name: "serverless-plugin-typescript",
      notes: [
        "Voke does not execute Serverless TypeScript hooks during migration.",
      ],
      status: "mapped",
      summary:
        "TypeScript workflow maps to the Voke Bun build and typecheck workflow.",
    },
    {
      manualSteps: [
        "Review required environment variables for local, synth, and eventual deployment because Voke will not copy dotenv plugin injection rules.",
      ],
      mappedBehavior: "Bun loads `.env` automatically for local commands.",
      name: "serverless-dotenv-plugin",
      notes: [
        "Bun provides local `.env` loading, but deployment-time environment wiring still needs review.",
      ],
      status: "mapped",
      summary: "Local dotenv behavior maps to Bun environment loading.",
    },
    {
      manualSteps: [
        "Review every per-function IAM statement and translate the required permissions into Voke resource bindings or CloudFormation policy configuration.",
      ],
      name: "serverless-iam-roles-per-function",
      notes: [
        "Voke generates one function role policy surface today; per-function IAM isolation is not converted automatically.",
      ],
      status: "manual",
      summary: "Per-function IAM behavior requires explicit security review.",
    },
    {
      manualSteps: [
        "Decide whether warmup is still needed; if it is, model the warmer as explicit infrastructure outside this stable migration phase.",
      ],
      name: "serverless-plugin-warmup",
      notes: [
        "Warmup scheduling changes runtime behavior and is not generated automatically.",
      ],
      status: "manual",
      summary: "Lambda warmup behavior requires manual migration.",
    },
    {
      manualSteps: [
        "Keep existing deployment pruning outside Voke stable commands until deployment lifecycle support becomes stable.",
      ],
      name: "serverless-prune-plugin",
      notes: [
        "Voke stable scope currently covers local/dev/build/synth, not deployment pruning.",
      ],
      status: "manual",
      summary: "Deployment pruning is outside the stable migration scope.",
    },
    {
      manualSteps: [
        "Recreate custom domains, certificates, and DNS records manually in infrastructure after the generated API shape is reviewed.",
      ],
      name: "serverless-domain-manager",
      notes: [
        "Custom domain resources are environment-specific and are not inferred safely.",
      ],
      status: "manual",
      summary:
        "Custom API domain management requires manual infrastructure migration.",
    },
    {
      manualSteps: [
        "Reapply Datadog layers, environment variables, tracing configuration, and monitors manually after handlers are migrated.",
      ],
      name: "serverless-plugin-datadog",
      notes: [
        "Observability plugins often inject layers and environment variables that Voke does not execute during migration.",
      ],
      status: "manual",
      summary: "Datadog instrumentation requires manual migration.",
    },
    {
      manualSteps: [
        "Recreate alarms, topics, and notification policies manually in CloudFormation or the chosen operations tooling.",
      ],
      name: "serverless-plugin-aws-alerts",
      notes: [
        "Alerting behavior is operational infrastructure and is not generated in this phase.",
      ],
      status: "manual",
      summary: "AWS alerting resources require manual migration.",
    },
    {
      manualSteps: [
        "Move Step Functions definitions and IAM permissions manually; Voke does not synthesize state machines in the stable local/dev/build/synth scope.",
      ],
      name: "serverless-step-functions",
      notes: [
        "State machines are application workflow infrastructure and are not converted automatically.",
      ],
      status: "manual",
      summary: "Step Functions definitions require manual migration.",
    },
    {
      manualSteps: [
        "Rebuild AppSync schema, resolvers, data sources, and permissions manually outside the generated Voke API skeleton.",
      ],
      name: "serverless-appsync-plugin",
      notes: [
        "AppSync is a separate API surface from Hono HTTP routes and is not converted automatically.",
      ],
      status: "manual",
      summary: "AppSync configuration requires manual migration.",
    },
    {
      manualSteps: [
        "Inspect the plugin documentation and migrate any generated resources, hooks, or packaging behavior manually.",
      ],
      name: "serverless-custom-unknown",
      notes: ["Unknown plugin behavior is preserved as manual migration work."],
      status: "manual",
      summary: "Unknown plugin behavior requires manual migration.",
    },
  ]);
  expect(migration.report.unsupported).toContain(
    "Unsupported Serverless plugin serverless-custom-unknown: behavior is unknown to Voke. Review the plugin documentation, then migrate any generated resources, hooks, or packaging behavior manually."
  );
  expect(migration.report.unsupported).toContain(
    "plugin serverless-iam-roles-per-function requires per-function IAM review before migration"
  );
  expect(migration.files["./voke-plugins/MIGRATION_REPORT.md"]).toContain(
    "## Plugin notes"
  );
  expect(migration.files["./voke-plugins/MIGRATION_REPORT.md"]).toContain(
    "`serverless-offline`"
  );
  expect(migration.files["./voke-plugins/MIGRATION_REPORT.md"]).toContain(
    "Voke does not run the Serverless Offline plugin"
  );
  expect(
    migration.files["./voke-plugins/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("`serverless-esbuild`");
  expect(
    migration.files["./voke-plugins/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("Voke uses Bun for builds");
  expect(
    migration.files["./voke-plugins/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("`serverless-custom-unknown`");
  expect(
    migration.files["./voke-plugins/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("Unknown plugin behavior is preserved as manual migration work.");
  expect(migration.files["./voke-plugins/src/stack.ts"]).toBeUndefined();
});

test("runs serverless migration through the CLI parser", async () => {
  const directory = `/private/tmp/voke-serverless-${crypto.randomUUID()}`;
  const serverlessPath = `${directory}/serverless.yml`;
  const outDirectory = `${directory}/voke`;

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(serverlessPath, serverlessYaml);

  await runCli([
    "migrate",
    "serverless",
    serverlessPath,
    "--out",
    outDirectory,
  ]);

  expect(await Bun.file(`${outDirectory}/voke.config.ts`).exists()).toBe(true);
  expect(await Bun.file(`${outDirectory}/src/index.ts`).exists()).toBe(true);
  expect(await Bun.file(`${outDirectory}/src/stack.ts`).exists()).toBe(false);
  expect(await Bun.file(`${outDirectory}/MIGRATION_REPORT.md`).exists()).toBe(
    true
  );
  expect(
    await Bun.file(`${outDirectory}/SERVERLESS_COMPATIBILITY.md`).exists()
  ).toBe(true);
});
