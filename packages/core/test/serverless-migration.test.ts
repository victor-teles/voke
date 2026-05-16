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
  });
  expect(service.package?.patterns).toEqual(["!test/**", "src/**"]);
  expect(service.plugins).toEqual(["serverless-offline", "serverless-webpack"]);
  expect(service.functions.listOrders?.events).toEqual([
    { method: "GET", path: "/orders", type: "httpApi" },
    { method: "POST", path: "/orders", type: "http" },
  ]);
  expect(service.functions.fulfillOrder?.events).toEqual([
    { arn: "arn:aws:sqs:sa-east-1:123456789012:orders", type: "sqs" },
    {
      eventBus: "orders",
      pattern: { source: ["orders"] },
      type: "eventBridge",
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
    "createApiApp"
  );
  expect(migration.files["./voke-orders/src/index.ts"]).toContain(
    "voke.config"
  );
  expect(migration.files["./voke-orders/src/routes/list-orders.ts"]).toContain(
    "listOrdersRoutes"
  );
  expect(
    migration.files["./voke-orders/src/functions/fulfill-order.ts"]
  ).toContain("defineFunction");
  expect(migration.files["./voke-orders/src/stack.ts"]).toBeUndefined();
  expect(migration.files["./voke-orders/MIGRATION_REPORT.md"]).toContain(
    "Unsupported features"
  );
  expect(
    migration.files["./voke-orders/SERVERLESS_COMPATIBILITY.md"]
  ).toContain("HTTP API event");
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
    "SQS event: fulfillOrder",
    "EventBridge event: fulfillOrder",
  ]);
  expect(migration.report.unsupported).toEqual([
    "plugin serverless-webpack requires manual migration",
    "schedule event on scheduledReport requires manual migration",
  ]);
  expect(migration.report.manualSteps).toContain(
    "Move one Serverless function at a time by routing migrated HTTP paths to Voke while the original service keeps the remaining functions."
  );
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
