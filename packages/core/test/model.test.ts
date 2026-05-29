import { expect, test } from "bun:test";

import {
  createAuthorizers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
} from "../src/authorizers";
import { parameter, secret } from "../src/aws";
import {
  dynamodbTable,
  secret as cloudFormationSecret,
  sqsQueue,
  ssmParameter,
} from "../src/cloudformation";
import { defineConfig } from "../src/config";
import { VokeConfigError } from "../src/errors";
import {
  defineFunction,
  defineFunctions,
  http,
  sqs,
  sqsEventSource,
  sqsMessageBatch,
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

test("builds a small serializable model from normalized config", () => {
  const model = createInternalModel(
    defineConfig({
      api: {
        name: "orders-http",
        routes: ["GET /orders", "POST /orders"],
      },
      build: {
        outdir: "./build",
      },
      cloudFormation: {
        environment: {
          LOG_LEVEL: "debug",
        },
        handler: "api.handler",
        resources: {
          eventsQueue: sqsQueue(),
          ordersTable: dynamodbTable({ partitionKey: "pk", sortKey: "sk" }),
        },
      },
      entrypoint: "./src/api.ts",
      name: "orders-api",
      region: "sa-east-1",
      runtime: {
        lambda: "nodejs22.x",
      },
      stage: "prod",
    })
  );

  expect(structuredClone(model)).toEqual(model);
  expect(model).toEqual({
    apis: {
      http: {
        name: "orders-http",
        protocol: "http",
        routes: [
          {
            function: "api",
            route: "GET /orders",
          },
          {
            function: "api",
            route: "POST /orders",
          },
        ],
      },
    },
    build: {
      entrypoint: "./src/api.ts",
      entrypoints: ["./src/api.ts"],
      outdir: "./build",
      target: "bun",
    },
    functions: {
      api: {
        bindings: [
          {
            attribute: "url",
            env: "VOKE_RESOURCE_EVENTS_QUEUE_URL",
            resource: "eventsQueue",
          },
          {
            attribute: "name",
            env: "VOKE_RESOURCE_ORDERS_TABLE_NAME",
            resource: "ordersTable",
          },
        ],
        deployedName: "orders-api-prod",
        entrypoint: "./src/api.ts",
        environment: {
          LOG_LEVEL: "debug",
        },
        eventSources: [],
        handler: "api.handler",
        invokable: false,
        routes: ["GET /orders", "POST /orders"],
        runtime: "nodejs22.x",
        variables: {},
      },
    },
    local: {
      provider: {
        adapter: "floci",
        optional: true,
      },
    },
    outputs: {
      apiFunctionName: {
        description: "api Lambda function name",
        source: {
          attribute: "name",
          function: "api",
        },
      },
      apiUrl: {
        description: "HTTP API URL",
        source: {
          api: "http",
          attribute: "url",
        },
      },
      eventsQueueUrl: {
        description: "eventsQueue url",
        source: {
          attribute: "url",
          resource: "eventsQueue",
        },
      },
      ordersTableName: {
        description: "ordersTable name",
        source: {
          attribute: "name",
          resource: "ordersTable",
        },
      },
    },
    resources: {
      eventsQueue: {
        access: {
          actions: [
            "sqs:SendMessage",
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
          ],
          level: "readWrite",
        },
        binding: {
          attribute: "url",
          env: "VOKE_RESOURCE_EVENTS_QUEUE_URL",
        },
        kind: "resource",
        properties: {},
        provider: {
          aws: {
            properties: {
              bindingValue: "ref",
              cloudFormationType: "AWS::SQS::Queue",
              outputName: "Url",
              policyResource: "getAttArn",
            },
            type: "cloudformation.resource",
          },
        },
      },
      ordersTable: {
        access: {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            "dynamodb:Scan",
          ],
          level: "readWrite",
        },
        binding: {
          attribute: "name",
          env: "VOKE_RESOURCE_ORDERS_TABLE_NAME",
        },
        kind: "resource",
        properties: {
          AttributeDefinitions: [
            {
              AttributeName: "pk",
              AttributeType: "S",
            },
            {
              AttributeName: "sk",
              AttributeType: "S",
            },
          ],
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            {
              AttributeName: "pk",
              KeyType: "HASH",
            },
            {
              AttributeName: "sk",
              KeyType: "RANGE",
            },
          ],
        },
        provider: {
          aws: {
            properties: {
              bindingValue: "ref",
              cloudFormationType: "AWS::DynamoDB::Table",
              outputName: "Name",
              policyResource: "getAttArn",
            },
            type: "cloudformation.resource",
          },
        },
      },
    },
    schemaVersion: "1",
    service: {
      name: "orders-api",
      region: "sa-east-1",
      stage: "prod",
    },
  });
});

test("stores provider resource metadata as provider-neutral extension records", () => {
  const model = createInternalModel({
    name: "provider-neutral-model",
    resources: {
      customTopic: {
        actions: ["sns:Publish"],
        bindingAttribute: "arn",
        bindingValue: "ref",
        cloudFormationType: "AWS::Custom::TopicLike",
        outputName: "Arn",
        policyResource: "ref",
        properties: {
          TopicName: "events",
        },
      },
    },
  });

  expect(model.resources.customTopic?.provider).toEqual({
    aws: {
      properties: {
        bindingValue: "ref",
        cloudFormationType: "AWS::Custom::TopicLike",
        outputName: "Arn",
        policyResource: "ref",
      },
      type: "cloudformation.resource",
    },
  });
});

test("keeps empty model sections explicit for minimal configs", () => {
  const model = createInternalModel({ name: "minimal-api" });
  const apiFunction = model.functions.api;

  if (apiFunction === undefined) {
    throw new Error("Expected default API function in the model");
  }

  expect(model.resources).toEqual({});
  expect(apiFunction.bindings).toEqual([]);
  expect(apiFunction.deployedName).toBe("minimal-api-local");
  expect(apiFunction.environment).toEqual({});
  expect(apiFunction.invokable).toBe(false);
  expect(apiFunction.routes).toEqual(["$default"]);
  expect(apiFunction.runtime).toBe("nodejs22.x");
  expect(model.apis.http?.name).toBe("minimal-api");
  expect(model.local.provider).toEqual({
    adapter: "floci",
    optional: true,
  });
});

test("maps explicit function definitions from config into the model", () => {
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
  const model = createInternalModel(
    defineConfig({
      cloudFormation: {
        environment: {
          LOG_LEVEL: "info",
        },
        resources: {
          eventsQueue: sqsQueue(),
        },
      },
      functions: defineFunctions({ sendWelcomeEmail }),
      name: "workers-api",
    })
  );

  expect(model.functions.sendWelcomeEmail).toEqual({
    bindings: [
      {
        attribute: "url",
        env: "VOKE_RESOURCE_EVENTS_QUEUE_URL",
        resource: "eventsQueue",
      },
    ],
    deployedName: "sendWelcomeEmail",
    entrypoint: "./src/functions/send-welcome-email.ts",
    environment: {
      EMAIL_FROM: "hello@example.com",
      LOG_LEVEL: "info",
    },
    eventSources: [],
    handler: "send-welcome-email.handler",
    invokable: true,
    routes: [],
    runtime: "nodejs24.x",
    variables: {},
  });
});

test("models endpoint, CRUD group, use case, and mixed functions consistently", () => {
  const app = new Voke();
  const model = createInternalModel({
    functions: defineFunctions({
      checkout: defineFunction({
        handler: (payload) => ({ id: payload.cartId }),
        input: schema<{ cartId: string }>(),
        output: schema<{ id: string }>(),
        synthesis: {
          entrypoint: "./src/functions/checkout.ts",
        },
      }),
      health: defineFunction({
        routes: [
          app.get("/health", {
            handler: () => ({ ok: true }),
          }),
        ],
        synthesis: {
          entrypoint: "./src/functions/health.ts",
        },
      }),
      orders: defineFunction({
        handler: (payload: { id: string }) => ({ id: payload.id }),
        input: schema<{ id: string }>(),
        output: schema<{ id: string }>(),
        routes: [
          app.get("/orders/:id", {
            handler: (request) => ({ id: request.params.id }),
            params: schema<{ id: string }>(),
          }),
        ],
        synthesis: {
          entrypoint: "./src/functions/orders.ts",
        },
      }),
      users: defineFunction({
        routes: [
          app.get("/users", {
            handler: () => [],
          }),
          app.post("/users", {
            handler: () => ({ id: "usr_1" }),
          }),
          app.get("/users/:id", {
            handler: (request) => ({ id: request.params.id }),
            params: schema<{ id: string }>(),
          }),
          app.patch("/users/:id", {
            handler: (request) => ({ id: request.params.id }),
            params: schema<{ id: string }>(),
          }),
          app.delete("/users/:id", {
            handler: () => ({ deleted: true }),
          }),
        ],
        synthesis: {
          entrypoint: "./src/functions/users.ts",
        },
      }),
    }),
    name: "function-model",
    stage: "prod",
  });

  expect(model.apis.http?.routes).toEqual([
    { function: "health", route: "GET /health" },
    { function: "orders", route: "GET /orders/:id" },
    { function: "users", route: "GET /users" },
    { function: "users", route: "POST /users" },
    { function: "users", route: "GET /users/:id" },
    { function: "users", route: "PATCH /users/:id" },
    { function: "users", route: "DELETE /users/:id" },
  ]);
  expect(model.functions.checkout).toMatchObject({
    deployedName: "function-model-prod-checkout",
    invokable: true,
    routes: [],
  });
  expect(model.functions.health).toMatchObject({
    deployedName: "function-model-prod-health",
    invokable: false,
    routes: ["GET /health"],
  });
  expect(model.functions.users).toMatchObject({
    deployedName: "function-model-prod-users",
    invokable: false,
    routes: [
      "GET /users",
      "POST /users",
      "GET /users/:id",
      "PATCH /users/:id",
      "DELETE /users/:id",
    ],
  });
  expect(model.functions.orders).toMatchObject({
    deployedName: "function-model-prod-orders",
    invokable: true,
    routes: ["GET /orders/:id"],
  });
});

test("models JWT Authorizers for route-backed Functions", () => {
  const app = new Voke();
  const authorizers = createAuthorizers({
    userJwt: jwtAuthorizer({
      audience: ["users-api"],
      issuer: "https://auth.example.com",
    }),
  });
  const model = createInternalModel({
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

  expect(model.apis.http?.authorizers).toEqual({
    userJwt: {
      audience: ["users-api"],
      identitySource: ["$request.header.Authorization"],
      issuer: "https://auth.example.com",
      type: "jwt",
    },
  });
  expect(model.apis.http?.routes).toEqual([
    {
      authorizer: "userJwt",
      function: "users",
      route: "GET /users/me",
    },
  ]);
});

test("models route authorizer inheritance, overrides, and explicit public routes", () => {
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
  const model = createInternalModel({
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

  expect(model.apis.http?.routes).toEqual([
    {
      authorizer: "userJwt",
      function: "users",
      route: "GET /users/me",
    },
    {
      authorizer: "adminJwt",
      function: "users",
      route: "GET /admin",
    },
    {
      function: "users",
      route: "GET /health",
    },
  ]);
});

test("models Lambda Authorizers with local Request Authorizer Function targets", () => {
  const app = new Voke();
  const authorizers = createAuthorizers({
    session: lambdaAuthorizer({ function: "authorizeSession" }),
  });
  const model = createInternalModel({
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
  });

  expect(model.apis.http?.authorizers).toEqual({
    session: {
      cacheTtlSeconds: 0,
      function: "authorizeSession",
      identitySource: ["$request.header.Authorization"],
      type: "lambda",
    },
  });
});

test("rejects invalid HTTP Authorizer references and duplicate names", () => {
  const app = new Voke();
  const userAuthorizers = createAuthorizers({
    userJwt: jwtAuthorizer({
      audience: "users-api",
      issuer: "https://auth.example.com",
    }),
  });

  expect(() =>
    createInternalModel({
      functions: defineFunctions({
        users: http({
          authorizers: userAuthorizers,
          routes: app.get("/admin", {
            authorizer: "adminJwt",
            handler: () => ({ ok: true }),
          }),
        }),
      }),
      name: "users-api",
    })
  ).toThrow('Route GET /admin references unknown HTTP Authorizer "adminJwt"');

  expect(() =>
    createInternalModel({
      functions: defineFunctions({
        admin: http({
          authorizers: createAuthorizers({
            userJwt: jwtAuthorizer({
              audience: "admin-api",
              issuer: "https://auth.example.com",
            }),
          }),
          routes: app.get("/admin", {
            handler: () => ({ ok: true }),
          }),
        }),
        users: http({
          authorizers: userAuthorizers,
          routes: app.get("/users/me", {
            handler: () => ({ id: "usr_1" }),
          }),
        }),
      }),
      name: "users-api",
    })
  ).toThrow('HTTP Authorizer "userJwt" has conflicting definitions');
});

test("models SQS event sources attached to Function definitions", () => {
  const processOrders = sqs({
    handler: (batch: SqsMessageBatch<{ orderId: string }>) => batch.ok(),
    message: schema<{ orderId: string }>(),
    name: "orders-consumer",
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
  const model = createInternalModel({
    functions: defineFunctions({ processOrders }),
    name: "orders-worker",
    resources: {
      ordersQueue: sqsQueue(),
      priorityQueue: sqsQueue(),
    },
    stage: "prod",
  });

  expect(model.functions.processOrders?.deployedName).toBe("orders-consumer");
  expect(model.functions.processOrders?.handler).toBe("process-orders.handler");
  expect(model.functions.processOrders?.invokable).toBe(false);
  expect(model.functions.processOrders?.eventSources).toEqual([
    {
      batchSize: 10,
      enabled: undefined,
      maxBatchingWindowSeconds: undefined,
      queue: "ordersQueue",
      type: "sqs",
    },
    {
      batchSize: 5,
      enabled: false,
      maxBatchingWindowSeconds: 30,
      queue: "priorityQueue",
      type: "sqs",
    },
  ]);
});

test("rejects SQS event source references to missing resources", () => {
  const processOrders = defineFunction({
    events: [sqsEventSource("missingQueue")],
    handler: (batch: SqsMessageBatch<{ orderId: string }>) => batch.ok(),
    input: sqsMessageBatch(schema<{ orderId: string }>()),
  });

  expect(() =>
    createInternalModel({
      functions: defineFunctions({ processOrders }),
      name: "invalid-worker",
    })
  ).toThrow(VokeConfigError);

  try {
    createInternalModel({
      functions: defineFunctions({ processOrders }),
      name: "invalid-worker",
    });
  } catch (error) {
    expect(error).toBeInstanceOf(VokeConfigError);
    expect(error).toMatchObject({
      issues: [
        {
          path: "functions.processOrders.events.0.queue",
        },
      ],
    });
  }
});

test("rejects invalid AWS resource-key Runtime Variables during model creation", () => {
  const checkout = defineFunction({
    handler: () => "ok",
    output: schema<string>(),
    variables: {
      missing: secret.fromResource("missingSecret"),
      wrongParameter: parameter.fromResource("signingSecret"),
      wrongSecret: secret.fromResource("publicConfig"),
    },
  });

  expect(() =>
    createInternalModel({
      functions: defineFunctions({ checkout }),
      name: "invalid-runtime-variables",
      resources: {
        publicConfig: ssmParameter({ value: "hello" }),
        signingSecret: cloudFormationSecret(),
      },
    })
  ).toThrow(VokeConfigError);

  try {
    createInternalModel({
      functions: defineFunctions({ checkout }),
      name: "invalid-runtime-variables",
      resources: {
        publicConfig: ssmParameter({ value: "hello" }),
        signingSecret: cloudFormationSecret(),
      },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(VokeConfigError);
    expect(error).toMatchObject({
      issues: [
        {
          path: "functions.checkout.variables.missing",
        },
        {
          path: "functions.checkout.variables.wrongParameter",
        },
        {
          path: "functions.checkout.variables.wrongSecret",
        },
      ],
    });
  }
});
