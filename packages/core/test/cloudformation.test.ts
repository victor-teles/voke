import { expect, test } from "bun:test";

import {
  createAuthorizers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
} from "../src/authorizers";
import {
  dynamodbTable,
  eventBus,
  s3Bucket,
  secret,
  snsTopic,
  sqsQueue,
  ssmParameter,
} from "../src/aws";
import {
  synthesizeCloudFormation,
  synthesizeCloudFormationFromModel,
} from "../src/cloudformation";
import { VokeModelError } from "../src/errors";
import {
  defineFunctions,
  defineFunction,
  http,
  sqsEventSource,
  sqsMessageBatch,
  sqs,
} from "../src/invoke";
import type { SqsMessageBatch, StandardSchemaV1 } from "../src/invoke";
import { createInternalModel } from "../src/model";
import { Voke } from "../src/route-builder";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const resourceAccessPolicyStatements = (
  template: ReturnType<typeof synthesizeCloudFormation>
) => {
  const role = template.Resources.FunctionRole;

  if (role === undefined) {
    throw new Error("Expected FunctionRole resource");
  }

  return role.Properties.Policies as
    | {
        PolicyDocument: {
          Statement: unknown[];
        };
      }[]
    | undefined;
};

const routeResource = (
  template: ReturnType<typeof synthesizeCloudFormation>,
  routeKey: string
) => {
  const route = Object.values(template.Resources).find(
    (resource) =>
      resource.Type === "AWS::ApiGatewayV2::Route" &&
      resource.Properties.RouteKey === routeKey
  );

  if (route === undefined) {
    throw new Error(`Expected route resource for ${routeKey}`);
  }

  return route;
};

test("matches the CloudFormation snapshot for an API stack with resources", async () => {
  const template = synthesizeCloudFormation({
    cloudFormation: {
      environment: {
        LOG_LEVEL: "info",
      },
      resources: {
        eventsQueue: sqsQueue(),
        ordersTable: dynamodbTable({ partitionKey: "pk", sortKey: "sk" }),
      },
    },
    name: "orders-api",
    region: "sa-east-1",
    stage: "prod",
  });
  const snapshot = await Bun.file(
    `${import.meta.dir}/fixtures/resources-cloudformation.json`
  ).json();

  expect(template).toEqual(snapshot);
});

test("matches the CloudFormation snapshot for an API stack with explicit functions", async () => {
  const sendWelcomeEmail = defineFunction({
    handler: (payload) => ({
      queued: true,
      to: payload.email,
    }),
    input: schema<{ email: string }>(),
    name: "sendWelcomeEmail",
    output: schema<{ queued: boolean; to: string }>(),
    synthesis: {
      entrypoint: "./src/functions/send-welcome-email.ts",
      environment: {
        EMAIL_FROM: "hello@example.com",
      },
      handler: "send-welcome-email.handler",
      runtime: "nodejs24.x",
    },
  });
  const template = synthesizeCloudFormation({
    cloudFormation: {
      environment: {
        LOG_LEVEL: "info",
      },
      resources: {
        eventsQueue: sqsQueue(),
      },
    },
    functions: defineFunctions({ sendWelcomeEmail }),
    name: "worker-api",
    region: "us-east-1",
    stage: "test",
  });
  const snapshot = await Bun.file(
    `${import.meta.dir}/fixtures/functions-cloudformation.json`
  ).json();

  expect(template).toEqual(snapshot);
});

test("matches the CloudFormation snapshot for SQS event source mappings", async () => {
  const processOrders = sqs({
    handler: (batch: SqsMessageBatch<{ orderId: string }>) => batch.ok(),
    message: schema<{ orderId: string }>(),
    queues: [
      "ordersQueue",
      {
        batchSize: 5,
        enabled: false,
        maxBatchingWindowSeconds: 30,
        queue: "priorityQueue",
      },
    ],
    synthesis: {
      entrypoint: "./src/functions/process-orders.ts",
    },
  });
  const template = synthesizeCloudFormation({
    functions: defineFunctions({ processOrders }),
    name: "orders-worker",
    resources: {
      ordersQueue: sqsQueue(),
      priorityQueue: sqsQueue(),
    },
    stage: "prod",
  });
  const snapshot = await Bun.file(
    `${import.meta.dir}/fixtures/sqs-event-source-cloudformation.json`
  ).json();

  expect(template).toEqual(snapshot);
});

test("synthesizes route-backed, invokable, and mixed functions from the Function registry", () => {
  const app = new Voke();
  const functions = defineFunctions({
    sendReceipt: defineFunction({
      handler: (payload: { orderId: string }) => ({
        sent: true,
        to: payload.orderId,
      }),
      input: schema<{ orderId: string }>(),
      output: schema<{ sent: boolean; to: string }>(),
      synthesis: {
        entrypoint: "./src/functions/send-receipt.ts",
      },
    }),
    users: defineFunction({
      handler: (payload: { id: string }) => ({
        id: payload.id,
      }),
      input: schema<{ id: string }>(),
      name: "prod-users-handler",
      output: schema<{ id: string }>(),
      routes: [
        app.get("/users/:id", {
          handler: (request) => ({ id: request.params.id }),
          params: schema<{ id: string }>(),
        }),
      ],
      synthesis: {
        entrypoint: "./src/functions/users.ts",
        handler: "users.handler",
      },
    }),
  });
  const template = synthesizeCloudFormation({
    functions,
    name: "function-first",
    stage: "prod",
  });

  expect(template.Resources.Function).toMatchObject({
    Metadata: {
      VokeDeployedName: "prod-users-handler",
      VokeEntrypoint: "./src/functions/users.ts",
      VokeFunction: "users",
      VokeRoutes: ["GET /users/:id"],
    },
    Properties: {
      FunctionName: "prod-users-handler",
      Handler: "users.handler",
    },
  });
  expect(template.Resources.SendReceiptFunction).toMatchObject({
    Metadata: {
      VokeDeployedName: "function-first-prod-sendReceipt",
      VokeEntrypoint: "./src/functions/send-receipt.ts",
      VokeFunction: "sendReceipt",
      VokeRoutes: [],
    },
    Properties: {
      FunctionName: "function-first-prod-sendReceipt",
      Handler: "send-receipt.handler",
    },
  });
  expect(template.Resources.Integration).toMatchObject({
    Properties: {
      IntegrationUri: { "Fn::GetAtt": ["Function", "Arn"] },
    },
  });
  expect(template.Resources.Route).toMatchObject({
    Properties: {
      RouteKey: "GET /users/:id",
    },
  });
  expect(template.Outputs).toMatchObject({
    FunctionName: {
      Value: { Ref: "Function" },
    },
    SendReceiptFunctionName: {
      Value: { Ref: "SendReceiptFunction" },
    },
  });
});

test("synthesizes JWT Authorizers for protected HTTP API routes", () => {
  const app = new Voke();
  const authorizers = createAuthorizers({
    userJwt: jwtAuthorizer({
      audience: "users-api",
      identitySource: "$request.header.X-Access-Token",
      issuer: "https://auth.example.com",
    }),
  });
  const template = synthesizeCloudFormation({
    functions: defineFunctions({
      users: http({
        authorizer: "userJwt",
        authorizers,
        routes: app.get("/users/me", {
          handler: () => ({ id: "usr_1" }),
        }),
      }),
    }),
    name: "users-api",
    stage: "prod",
  });

  expect(template.Resources.UserJwtAuthorizer).toEqual({
    Properties: {
      ApiId: { Ref: "Api" },
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.X-Access-Token"],
      JwtConfiguration: {
        Audience: ["users-api"],
        Issuer: "https://auth.example.com",
      },
      Name: "userJwt",
    },
    Type: "AWS::ApiGatewayV2::Authorizer",
  });
  expect(template.Resources.Route).toMatchObject({
    Properties: {
      AuthorizationType: "JWT",
      AuthorizerId: { Ref: "UserJwtAuthorizer" },
      RouteKey: "GET /users/me",
    },
  });
});

test("synthesizes route authorizer overrides and explicit public routes", () => {
  const app = new Voke();
  const authorizers = createAuthorizers({
    adminJwt: jwtAuthorizer({
      audience: "admin-api",
      issuer: "https://admin.example.com",
    }),
    userJwt: jwtAuthorizer({
      audience: "users-api",
      issuer: "https://auth.example.com",
    }),
  });
  const template = synthesizeCloudFormation({
    functions: defineFunctions({
      users: http({
        authorizer: "userJwt",
        authorizers,
        routes: [
          app.get("/users/me", {
            handler: () => ({ id: "usr_1" }),
          }),
          app.get("/admin", {
            authorizer: "adminJwt",
            handler: () => ({ ok: true }),
          }),
          app.get("/health", {
            authorizer: "none",
            handler: () => ({ ok: true }),
          }),
        ],
      }),
    }),
    name: "users-api",
  });

  expect(routeResource(template, "GET /users/me").Properties).toMatchObject({
    AuthorizationType: "JWT",
    AuthorizerId: { Ref: "UserJwtAuthorizer" },
  });
  expect(routeResource(template, "GET /admin").Properties).toMatchObject({
    AuthorizationType: "JWT",
    AuthorizerId: { Ref: "AdminJwtAuthorizer" },
  });
  expect(routeResource(template, "GET /health").Properties).not.toContainKeys([
    "AuthorizationType",
    "AuthorizerId",
  ]);
});

test("synthesizes Lambda Authorizers for local Request Authorizer Functions", () => {
  const app = new Voke();
  const authorizers = createAuthorizers({
    session: lambdaAuthorizer({
      cacheTtlSeconds: 60,
      function: "authorizeSession",
      identitySource: "$request.header.X-Session",
    }),
  });
  const template = synthesizeCloudFormation({
    functions: defineFunctions({
      authorizeSession: requestAuthorizer({
        handler: () => ({ authorized: true }),
      }),
      users: http({
        authorizer: "session",
        authorizers,
        routes: app.get("/me", {
          handler: () => ({ ok: true }),
        }),
      }),
    }),
    name: "users-api",
    stage: "prod",
  });

  expect(template.Resources.SessionAuthorizer).toEqual({
    Properties: {
      ApiId: { Ref: "Api" },
      AuthorizerPayloadFormatVersion: "2.0",
      AuthorizerResultTtlInSeconds: 60,
      AuthorizerType: "REQUEST",
      AuthorizerUri: {
        "Fn::Sub": `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${AuthorizeSessionFunction.Arn}/invocations`,
      },
      EnableSimpleResponses: true,
      IdentitySource: ["$request.header.X-Session"],
      Name: "session",
    },
    Type: "AWS::ApiGatewayV2::Authorizer",
  });
  expect(template.Resources.Route).toMatchObject({
    Properties: {
      AuthorizationType: "CUSTOM",
      AuthorizerId: { Ref: "SessionAuthorizer" },
    },
  });
  expect(template.Resources.SessionAuthorizerPermission).toMatchObject({
    Properties: {
      Action: "lambda:InvokeFunction",
      FunctionName: { Ref: "AuthorizeSessionFunction" },
      Principal: "apigateway.amazonaws.com",
    },
    Type: "AWS::Lambda::Permission",
  });
});

test("synthesizes external Lambda Authorizer targets without permissions", () => {
  const app = new Voke();
  const authorizers = createAuthorizers({
    externalArn: lambdaAuthorizer({
      function: {
        arn: "arn:aws:lambda:us-east-1:123456789012:function:shared-auth",
      },
    }),
    externalName: lambdaAuthorizer({
      function: {
        deployedName: "shared-auth",
      },
    }),
  });
  const template = synthesizeCloudFormation({
    functions: defineFunctions({
      users: http({
        authorizers,
        routes: [
          app.get("/name", {
            authorizer: "externalName",
            handler: () => ({ ok: true }),
          }),
          app.get("/arn", {
            authorizer: "externalArn",
            handler: () => ({ ok: true }),
          }),
        ],
      }),
    }),
    name: "users-api",
  });

  expect(template.Resources.ExternalNameAuthorizer).toMatchObject({
    Properties: {
      AuthorizerUri: {
        "Fn::Sub": `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:shared-auth/invocations`,
      },
    },
  });
  expect(template.Resources.ExternalArnAuthorizer).toMatchObject({
    Properties: {
      AuthorizerUri: {
        "Fn::Sub": `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:shared-auth/invocations`,
      },
    },
  });
  expect(template.Resources.ExternalNameAuthorizerPermission).toBeUndefined();
  expect(template.Resources.ExternalArnAuthorizerPermission).toBeUndefined();
});

test("omits the inline resource access policy when no resources are configured", () => {
  const template = synthesizeCloudFormation({
    name: "minimal-api",
  });

  expect(resourceAccessPolicyStatements(template)).toBeUndefined();
});

test("generates resource-specific IAM policy statements for each AWS helper", () => {
  const configValueArn = `arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/\${ConfigValue}`;
  const uploadsBucketObjectArn = `\${UploadsBucket.Arn}/*`;
  const template = synthesizeCloudFormation({
    name: "policy-api",
    resources: {
      auditBus: eventBus(),
      configValue: ssmParameter({ value: "enabled" }),
      eventsQueue: sqsQueue(),
      orderCreatedTopic: snsTopic(),
      ordersTable: dynamodbTable(),
      signingSecret: secret(),
      uploadsBucket: s3Bucket(),
    },
  });
  const policies = resourceAccessPolicyStatements(template);
  const statements = policies?.[0]?.PolicyDocument.Statement;

  expect(statements).toEqual([
    {
      Action: ["events:PutEvents"],
      Effect: "Allow",
      Resource: { "Fn::GetAtt": ["AuditBus", "Arn"] },
    },
    {
      Action: ["ssm:GetParameter", "ssm:GetParameters"],
      Effect: "Allow",
      Resource: {
        "Fn::Sub": [configValueArn, {}],
      },
    },
    {
      Action: [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
      ],
      Effect: "Allow",
      Resource: { "Fn::GetAtt": ["EventsQueue", "Arn"] },
    },
    {
      Action: ["sns:Publish"],
      Effect: "Allow",
      Resource: { Ref: "OrderCreatedTopic" },
    },
    {
      Action: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
      ],
      Effect: "Allow",
      Resource: { "Fn::GetAtt": ["OrdersTable", "Arn"] },
    },
    {
      Action: ["secretsmanager:GetSecretValue"],
      Effect: "Allow",
      Resource: { "Fn::GetAtt": ["SigningSecret", "Arn"] },
    },
    {
      Action: ["s3:ListBucket"],
      Effect: "Allow",
      Resource: { "Fn::GetAtt": ["UploadsBucket", "Arn"] },
    },
    {
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Effect: "Allow",
      Resource: { "Fn::Sub": [uploadsBucketObjectArn, {}] },
    },
  ]);
});

test("can synthesize directly from the internal model for advanced usage", () => {
  const model = createInternalModel({
    name: "model-api",
    resources: {
      eventsQueue: sqsQueue(),
    },
  });

  expect(synthesizeCloudFormationFromModel(model)).toEqual(
    synthesizeCloudFormation({
      name: "model-api",
      resources: {
        eventsQueue: sqsQueue(),
      },
    })
  );
});

test("synthesizes SQS event source mappings for Function event sources", () => {
  const processOrders = defineFunction({
    events: [
      sqsEventSource("ordersQueue"),
      sqsEventSource("priorityQueue", {
        batchSize: 5,
        enabled: false,
        maxBatchingWindowSeconds: 30,
      }),
    ],
    handler: (batch: SqsMessageBatch<{ orderId: string }>) => batch.ok(),
    input: sqsMessageBatch(schema<{ orderId: string }>()),
    synthesis: {
      entrypoint: "./src/functions/process-orders.ts",
    },
  });
  const template = synthesizeCloudFormation({
    functions: defineFunctions({ processOrders }),
    name: "orders-worker",
    resources: {
      ordersQueue: sqsQueue(),
      priorityQueue: sqsQueue(),
    },
    stage: "prod",
  });

  expect(template.Resources.FunctionOrdersQueueEventSourceMapping).toEqual({
    Properties: {
      BatchSize: 10,
      Enabled: true,
      EventSourceArn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
      FunctionName: { Ref: "Function" },
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumBatchingWindowInSeconds: 0,
    },
    Type: "AWS::Lambda::EventSourceMapping",
  });
  expect(template.Resources.FunctionPriorityQueueEventSourceMapping).toEqual({
    Properties: {
      BatchSize: 5,
      Enabled: false,
      EventSourceArn: { "Fn::GetAtt": ["PriorityQueue", "Arn"] },
      FunctionName: { Ref: "Function" },
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumBatchingWindowInSeconds: 30,
    },
    Type: "AWS::Lambda::EventSourceMapping",
  });
});

test("rejects invalid SQS event source mappings from direct model synthesis", () => {
  const processOrders = defineFunction({
    events: [sqsEventSource("ordersQueue")],
    handler: (batch: SqsMessageBatch<{ orderId: string }>) => batch.ok(),
    input: sqsMessageBatch(schema<{ orderId: string }>()),
  });
  const model = createInternalModel({
    functions: defineFunctions({ processOrders }),
    name: "orders-worker",
    resources: {
      ordersQueue: sqsQueue(),
    },
  });

  if (model.functions.processOrders === undefined) {
    throw new Error("Expected processOrders function in the model");
  }

  model.functions.processOrders.eventSources = [
    {
      queue: "missingQueue",
      type: "sqs",
    },
  ];

  expect(() => synthesizeCloudFormationFromModel(model)).toThrow(
    VokeModelError
  );
});
