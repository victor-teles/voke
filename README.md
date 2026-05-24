# voke

Voke is a TypeScript-first AWS Lambda framework. You describe work as Functions, collect them in a Function Registry, expose route-backed Functions through a Gateway, and use the Route Builder when a Function should also be an HTTP route.

## Quickstart

Create `voke.config.ts` for project, build, and CloudFormation settings:

```ts
import { defineConfig } from "voke";
import { dynamodbTable, sqsQueue } from "voke/aws";

export default defineConfig({
  name: "hello-api",
  stage: "local",
  region: "us-east-1",
  entrypoint: "./src/index.ts",
  cloudFormation: {
    resources: {
      usersTable: dynamodbTable({ partitionKey: "id" }),
      eventsQueue: sqsQueue(),
    },
  },
});
```

Then create Functions with explicit Function Contracts and mount them in a Gateway:

```ts
import { createFunctions, http, route, voke } from "voke";
import config from "../voke.config";

const functions = createFunctions({
  http: http({
    routes: [
      route.get("/", {
        handler: () => ({ message: "Hello from Voke" }),
      }),
      route.get("/health", {
        handler: () => ({ ok: true, service: config.name }),
      }),
    ],
  }),
});

const gateway = voke(functions, { config });

export default gateway;
```

The default export has an constant `handler` accepts AWS Lambda HTTP API v2 events. For local tests, call the Gateway directly:

```ts
const response = await gateway.request("/health");
```

Voke still uses Hono-compatible HTTP primitives under the hood, but the first-party authoring model is the Voke Function API: `createFunctions`, `fn`, `http`, `route`, `sqs`, and `voke`.

## Vocabulary

- **Function**: a unit of Lambda work. It can be invokable, route-backed, or both.
- **Function Contract**: Standard Schema-compatible input, output, params, query, headers, and body types that validate Function boundaries.
- **Function Registry**: the `createFunctions({ ... })` collection that gives Functions stable typed names.
- **Route Builder**: the `route.get(...)`, `.post(...)`, and `.route(...)` API for declaring typed HTTP routes.
- **Gateway**: the `voke(functions)` runtime that activates local Function invocation and mounts route-backed Functions.

## Monorepo

This repository uses Bun workspaces and Turborepo.

- `packages/core` contains the framework package.
- `examples/hello-api` contains a small TypeScript-first Gateway example.
- `examples/e2e` contains local API, Function invoke, Gateway request, and deployed smoke examples.

## CLI

The first Voke CLI commands are:

```bash
voke dev [entrypoint]
voke build [entrypoint] [outdir]
voke create api <name> [directory]
voke synth [entrypoint] [out] --config voke.config.ts
voke deploy --name hello-api --stage local --template ./dist/cloudformation.json
voke remove --name hello-api --stage local
voke migrate serverless [serverless.yml] --out ./voke-migration
```

## AWS and CloudFormation

Voke synthesizes a direct CloudFormation template for a Gateway-backed Lambda API, API Gateway HTTP API, Lambda IAM role, environment variables, outputs, Function Registry entries, and common AWS resources from the same normalized config:

```bash
voke synth
voke local bootstrap
```

Runtime code can read the generated environment bindings and pass consistent config into AWS SDK clients:

```ts
import { bindResource, createAwsClientConfig } from "voke/aws";

const usersTable = bindResource("usersTable", "name");

const dynamoConfig = createAwsClientConfig();
const tableName = usersTable.value();
```

Resource helpers are included for DynamoDB, SQS, SNS, EventBridge, S3, Secrets Manager, and Parameter Store.

## SQS Event Sources

SQS Event Source Functions use the same Function Registry model, but receive normalized message batches instead of direct `functions.invoke(...)` payloads:

```ts
import { createFunctions, sqs } from "voke";
import { createSqsEventHandler } from "voke/invoke";

const processOrder = sqs({
  batchSize: 10,
  handler: async (batch) => {
    for (const message of batch.messages) {
      await processOrderMessage(message.body);
    }

    return batch.ok();
  },
  message: orderMessageSchema,
  queue: "ordersQueue",
});

export const functions = createFunctions({ processOrder });
export const handler = createSqsEventHandler({
  function: "processOrder",
  functions,
});
```

Use `functions.sendEvent("processOrder", { messages: [...] })` in local tests. Voke parses each JSON message body with the Standard Schema-compatible message schema, reports invalid messages as partial batch failures by default, and synthesizes Lambda event source mappings with `ReportBatchItemFailures` enabled.

`sqsQueue()` defines the AWS queue resource; `sqs({ queue: "ordersQueue" })` attaches that queue to a Function. Local tests may pass minimal `{ body }` messages and optionally `source: "sqs"`. SQS Event Source Functions cannot mix with HTTP routes or invokable output contracts in v1, and queue DLQ/redrive settings stay with future queue resource lifecycle work.

## Function Invocation

Define invokable Functions with Standard Schema-compatible input/output contracts, group them in a Function Registry, and call them through `functions.invoke(...)`:

```ts
import { createFunctions, fn } from "voke";
import type { StandardSchemaV1 } from "voke/schema";

const userInput: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "example",
    version: 1,
  },
};

const getUser = fn({
  input: userInput,
  output: userInput,
  handler: async (payload) => ({ id: payload.id, name: "Victor" }),
});

const functions = createFunctions({ getUser });

const user = await functions.invoke("getUser", { id: "usr_1" });
```

`functions.invoke(...)` supports local and AWS runtimes, sync and async modes, Function Contract parsing, tracing metadata, retries, and timeouts. The optional `fn({ name })` value is a deployed Lambda name override; the registry key remains the stable type-safe Function identity.

## Gateway Routes

Route-backed Functions can be called through the typed Route Builder path or as real HTTP requests:

```ts
const routeResult = await functions.route("GET", "/health");
const response = await gateway.request("/health");
```

Use `functions.route(...)` for direct typed route calls and `gateway.request(...)` when a test should exercise HTTP method, path, headers, query strings, and response serialization.

## Local AWS With Floci

Voke local AWS support targets [Floci](https://floci.io/), a local AWS emulator that runs on port `4566` and works with the standard AWS SDK/CLI endpoint variable `AWS_ENDPOINT_URL`.

```bash
voke local start
voke local bootstrap --name hello-api --stage local
voke local stop
voke local reset
```

You can also use the local helpers directly:

```ts
import {
  createFlociComposeConfig,
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "voke/local";

const compose = createFlociComposeConfig();
const env = createLocalAwsEnvironment();
const bindings = createLocalResourceBindings(template);
```

## Serverless Framework Migration

Generate a Voke migration skeleton from an existing `serverless.yml`:

```bash
voke migrate serverless ./serverless.yml --out ./voke-migration
```

The migrator detects service/provider settings, Functions, HTTP API and REST API routes, resolvable SQS Event Sources, EventBridge workers, safe native CloudFormation resources, environment variables, IAM statements, package patterns, and plugins. It writes Function-first route and worker skeletons, config-first resource declarations, and stable migration reports with confidence levels and risk-grouped manual work.

See [docs/serverless-framework-migration.md](./docs/serverless-framework-migration.md) for common migration shapes.

## E2E Testing

Voke includes helpers for first-class Function, Gateway, and AWS integration tests:

```ts
import { createTestClient } from "voke/testing";
import service from "../src/index";

const client = createTestClient(service);
const response = await client.get("/health");
```

Use `functions.invoke(...)` for invokable Functions, `functions.route(...)` for typed Route Builder calls, `gateway.request(...)` for Gateway HTTP requests, `createTestClient()` for Lambda/API Gateway semantics or deployed stack smoke tests, `createStackTestContext()` for CloudFormation outputs and Floci seed plans, and `createInvokeTestClient()` for worker flows.

See [docs/e2e-testing.md](./docs/e2e-testing.md) and [examples/e2e](./examples/e2e).

## Common Commands

```bash
bun install
bun test
bun run typecheck
bun run release:check
bun run build
bun run --filter @voke/hello-api dev
```

Then open:

```bash
curl http://localhost:3000
```

Bun starts the example from its default exported Gateway because `voke(functions)` exposes a `fetch` handler.
