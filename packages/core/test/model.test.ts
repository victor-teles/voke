import { expect, test } from "bun:test";

import {
  createAuthorizers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
  parameter,
  secret,
  sqs,
} from "@voke/aws";
import type { SqsMessageBatch } from "@voke/aws";
import {
  dynamodbTable,
  secret as cloudFormationSecret,
  sqsQueue,
  ssmParameter,
} from "@voke/aws/cloudformation";

import { defineConfig } from "../src/config";
import { VokeConfigError } from "../src/errors";
import { fn, createFunctions, http } from "../src/invoke";
import type { EventFunctionDefinition, StandardSchemaV1 } from "../src/invoke";
import { createInternalModel } from "../src/model";
import { route, Voke } from "../src/route-builder";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value }),
    vendor: "voke-test",
    version: 1,
  },
});

test("builds a small serializable model from normalized config", () => {
  const app = new Voke();
  const model = createInternalModel({
    ...defineConfig({
      api: {
        name: "orders-http",
      },
      build: {
        outdir: "./build",
      },
      entrypoint: "./src/api.ts",
      environment: {
        LOG_LEVEL: "debug",
      },
      name: "orders-api",
      region: "sa-east-1",
      resources: {
        eventsQueue: sqsQueue(),
        ordersTable: dynamodbTable({ partitionKey: "pk", sortKey: "sk" }),
      },
      runtime: {
        memory: 512,
      },
      stage: "prod",
    }),
    functions: createFunctions({
      api: http({
        routes: [
          app.get("/orders", { handler: () => [] }),
          app.post("/orders", { handler: () => ({ created: true }) }),
        ],
      }),
    }),
  });

  expect(structuredClone(model)).toEqual(model);
  expect(model).toEqual({
    apis: {
      http: {
        name: "orders-http",
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
        deployedName: "orders-api-prod-api",
        entrypoint: "./src/api.ts",
        environment: {
          LOG_LEVEL: "debug",
        },
        eventSources: [],
        handler: "index.api",
        invokable: false,
        memory: 512,
        routes: ["GET /orders", "POST /orders"],
        timeout: 15,
        variables: {},
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

  // Without Functions from the entrypoint there is nothing to deploy as a Lambda or an API.
  expect(model.functions).toEqual({});
  expect(model.apis).toEqual({});
  expect(model.outputs).toEqual({});
  expect(model.resources).toEqual({});
  // The Local AWS Provider is a Provider option, not part of the provider-neutral model.
  expect("local" in model).toBe(false);
});

test("names every deployed Function <name>-<stage>-<key> and points it at the generated handler", () => {
  const app = new Voke();
  const model = createInternalModel({
    functions: createFunctions({
      api: http({ routes: [app.get("/health", { handler: () => "ok" })] }),
      "send-email": fn({
        handler: () => "sent",
        output: schema<string>(),
      }),
    }),
    name: "shop",
    stage: "prod",
  });

  expect(model.functions.api?.deployedName).toBe("shop-prod-api");
  expect(model.functions.api?.handler).toBe("index.api");
  expect(model.functions["send-email"]?.deployedName).toBe(
    "shop-prod-send-email"
  );
  expect(model.functions["send-email"]?.handler).toBe("index.sendEmail");
});

test("rejects registry keys that map to the same Lambda handler export", () => {
  expect(() =>
    createInternalModel({
      functions: createFunctions({
        "send-email": fn({
          handler: () => "a",
          output: schema<string>(),
        }),
        sendEmail: fn({
          handler: () => "c",
          output: schema<string>(),
        }),
        send_email: fn({
          handler: () => "b",
          output: schema<string>(),
        }),
      }),
      name: "shop",
    })
  ).toThrow(
    'Functions "send-email" and "sendEmail" both map to the Lambda handler export "sendEmail"'
  );
});

test("maps explicit function definitions from config into the model", () => {
  const sendWelcomeEmail = fn({
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
      memory: 256,
      provider: {
        aws: {
          properties: { architecture: "x86_64" },
          type: "lambda.function",
        },
      },
      timeout: 60,
    },
  });
  const model = createInternalModel({
    environment: {
      LOG_LEVEL: "info",
    },
    functions: createFunctions({ sendWelcomeEmail }),
    name: "workers-api",
    resources: {
      eventsQueue: sqsQueue(),
    },
  });

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
    memory: 256,
    provider: {
      aws: { properties: { architecture: "x86_64" }, type: "lambda.function" },
    },
    routes: [],
    timeout: 60,
    variables: {},
  });
});

test("models endpoint, CRUD group, use case, and mixed functions consistently", () => {
  const app = new Voke();
  const model = createInternalModel({
    functions: createFunctions({
      checkout: fn({
        handler: (payload) => ({ id: payload.cartId }),
        input: schema<{ cartId: string }>(),
        output: schema<{ id: string }>(),
        synthesis: {
          entrypoint: "./src/functions/checkout.ts",
        },
      }),
      health: fn({
        routes: [
          app.get("/health", {
            handler: () => ({ ok: true }),
          }),
        ],
        synthesis: {
          entrypoint: "./src/functions/health.ts",
        },
      }),
      orders: fn({
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
      users: fn({
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
    functions: createFunctions({
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
    functions: createFunctions({
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
    functions: createFunctions({
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
      functions: createFunctions({
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
      functions: createFunctions({
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
    functions: createFunctions({ processOrders }),
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
      properties: {
        batchSize: 10,
        enabled: true,
        maxBatchingWindowSeconds: 0,
      },
      resource: "ordersQueue",
      type: "sqs",
    },
    {
      properties: {
        batchSize: 5,
        enabled: false,
        maxBatchingWindowSeconds: 30,
      },
      resource: "priorityQueue",
      type: "sqs",
    },
  ]);
});

test("copies an Event Source of any type to the model untouched when no Provider is configured", () => {
  const nightly: EventFunctionDefinition = {
    events: [{ properties: { cron: "0 3 * * *" }, source: "custom" }],
    handler: () => "done",
    input: schema<unknown>(),
    key: "",
    kind: "event",
  };
  const model = createInternalModel({
    functions: createFunctions({ nightly }),
    name: "custom-events",
  });

  expect(model.functions.nightly?.eventSources).toEqual([
    { properties: { cron: "0 3 * * *" }, type: "custom" },
  ]);
});

test("rejects SQS event source references to missing resources", () => {
  const processOrders = sqs({
    handler: (batch: SqsMessageBatch<{ orderId: string }>) => batch.ok(),
    message: schema<{ orderId: string }>(),
    queue: "missingQueue",
  });

  expect(() =>
    createInternalModel({
      functions: createFunctions({ processOrders }),
      name: "invalid-worker",
    })
  ).toThrow(VokeConfigError);

  try {
    createInternalModel({
      functions: createFunctions({ processOrders }),
      name: "invalid-worker",
    });
  } catch (error) {
    expect(error).toBeInstanceOf(VokeConfigError);
    expect(error).toMatchObject({
      issues: [
        {
          message:
            '"sqs" Event Source references resource "missingQueue", but no matching resource is defined.',
          path: "functions.processOrders.events.0.resource",
        },
      ],
    });
  }
});

test("rejects invalid AWS resource-key Runtime Variables during model creation", () => {
  const checkout = fn({
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
      functions: createFunctions({ checkout }),
      name: "invalid-runtime-variables",
      resources: {
        publicConfig: ssmParameter({ value: "hello" }),
        signingSecret: cloudFormationSecret(),
      },
    })
  ).toThrow(VokeConfigError);

  try {
    createInternalModel({
      functions: createFunctions({ checkout }),
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

test("resolves Function timeout and memory from synthesis, then runtime, then defaults", () => {
  const model = createInternalModel({
    functions: createFunctions({
      configured: fn({
        handler: () => ({ ok: true }),
        output: schema<{ ok: boolean }>(),
      }),
      tuned: fn({
        handler: () => ({ ok: true }),
        output: schema<{ ok: boolean }>(),
        synthesis: { memory: 2048, timeout: 120 },
      }),
    }),
    name: "resolution-api",
    runtime: { timeout: 45 },
  });

  expect(model.functions.configured).toMatchObject({
    memory: 1024,
    timeout: 45,
  });
  expect(model.functions.tuned).toMatchObject({ memory: 2048, timeout: 120 });
  expect("provider" in (model.functions.configured ?? {})).toBe(false);
});

test("rejects invalid Function synthesis timeout, memory and the moved runtime", () => {
  const modelWith = (synthesis: Record<string, unknown>) => () =>
    createInternalModel({
      functions: createFunctions({
        worker: fn({
          handler: () => ({ ok: true }),
          output: schema<{ ok: boolean }>(),
          synthesis: synthesis as never,
        }),
      }),
      name: "invalid-synthesis-api",
    });

  expect(modelWith({ timeout: 0 })).toThrow(
    "Invalid Voke config at functions.worker.synthesis.timeout: expected a positive integer number of seconds; received 0"
  );
  expect(modelWith({ memory: 64.5 })).toThrow(
    "Invalid Voke config at functions.worker.synthesis.memory: expected a positive integer number of MB; received 64.5"
  );
  expect(modelWith({ runtime: "nodejs24.x" })).toThrow(
    'Invalid Voke config at functions.worker.synthesis.runtime: "synthesis.runtime" moved; use synthesis.provider.aws'
  );
});

test("carries normalized CORS onto the HTTP API model", () => {
  const model = createInternalModel({
    api: { cors: true },
    functions: createFunctions({
      api: http({
        routes: [route.get("/health", { handler: () => ({ ok: true }) })],
      }),
    }),
    name: "cors-api",
  });

  expect(model.apis.http?.cors).toEqual({
    credentials: false,
    headers: ["*"],
    methods: ["*"],
    origins: ["*"],
  });
});
