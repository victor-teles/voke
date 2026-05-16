# voke

Voke is planned as an AWS Lambda framework made with Hono and Bun, focused on simple API development, CloudFormation-native AWS integration, local AWS emulation, Serverless Framework migration, E2E testing, and AI-native development skills.

See the [roadmap](./ROADMAP.md) for the planned direction.

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

Then create a Hono API and wrap it with `api()`:

```ts
import { api, createApiApp, json } from "voke";
import config from "../voke.config";
import { usersRoutes } from "./routes/users";

const app = createApiApp({
  config,
  routes: [usersRoutes],
});

app.get("/", () => json({ message: "Hello from Voke" }));

const helloApi = api(app, { config });

export const handler = helloApi.handler;
export default helloApi;
```

The exported `handler` accepts AWS Lambda HTTP API v2 events:

```ts
const response = await handler({
  rawPath: "/",
  requestContext: {
    http: {
      method: "GET",
      path: "/",
    },
  },
});
```

Voke uses Hono's official `hono/aws-lambda` adapter under the hood, so Lambda event conversion, binary response handling, and AWS context bindings stay aligned with Hono.

## Monorepo

This repository uses Bun workspaces and Turborepo.

- `packages/core` contains the framework package.
- `examples/hello-api` contains a small example API.

## API Project Layout

Voke apps can be organized with route modules and middleware:

```txt
src/
  index.ts
  middleware/
    request-info.ts
  routes/
    health.ts
    users.ts
```

Use:

- `createApiApp()` to create a configured Hono app with default JSON errors.
- `routeModule()` to mount route groups with a `basePath`.
- `json()` and `jsonError()` for `{ data: ... }` and `{ error: ... }` responses.
- `getConfig()`, `awsEvent()`, `awsContext()`, and `requestId()` inside handlers/middleware.

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

Voke can synthesize a direct CloudFormation template for a Hono Lambda API, API Gateway HTTP API, Lambda IAM role, environment variables, outputs, and common AWS resources from the same normalized config:

```bash
voke synth
voke local bootstrap
```

Both commands read `voke.config.ts` by default, so apps do not need a separate `src/stack.ts` file for the normal local/build/synth workflow.

Runtime code can read the generated environment bindings and pass consistent config into AWS SDK clients:

```ts
import { bindResource, createAwsClientConfig } from "voke";

const usersTable = bindResource("usersTable", "name");

const dynamoConfig = createAwsClientConfig();
const tableName = usersTable.value();
```

Resource helpers are included for DynamoDB, SQS, SNS, EventBridge, S3, Secrets Manager, and Parameter Store.

## API-to-API Invoke

Define local functions with typed payloads/results, register them in the local runtime, and call them through `invoke()` from API handlers:

```ts
import { defineFunction, invoke, registerLocalFunction } from "voke";

const getUser = defineFunction({
  name: "getUser",
  handler: async (payload: { id: string }) => {
    return { id: payload.id, name: "Victor" };
  },
});

registerLocalFunction(getUser);

const user = await invoke<{ id: string }, { id: string; name: string }>(
  "getUser",
  {
    id: "usr_1",
  }
);
```

For strongly typed call sites, create a registry-scoped invoker:

```ts
import { createFunctionRegistry, createInvoker } from "voke";

const functions = createFunctionRegistry({ getUser });
const call = createInvoker(functions);

const user = await call("getUser", { id: "usr_1" });
```

`invoke()` supports local and AWS runtimes, sync and async modes, payload validation hooks, tracing metadata, retries, and timeouts. The AWS runtime accepts an injectable transport, so applications can wire the AWS SDK Lambda client without making it a hard dependency of Voke core.

## Local AWS With Floci

Voke local AWS support targets [Floci](https://floci.io/), a local AWS emulator that runs on port `4566` and works with the standard AWS SDK/CLI endpoint variable `AWS_ENDPOINT_URL`.

Start the local emulator:

```bash
voke local start
```

Bootstrap a local CloudFormation stack against Floci:

```bash
voke local bootstrap --name hello-api --stage local
```

Stop or reset local AWS:

```bash
voke local stop
voke local reset
```

You can also use the local helpers directly:

```ts
import {
  createFlociComposeConfig,
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "voke";

const compose = createFlociComposeConfig();
const env = createLocalAwsEnvironment();
const bindings = createLocalResourceBindings(template);
```

The generated environment sets `AWS_ENDPOINT_URL`, `VOKE_AWS_ENDPOINT_URL`, dummy AWS credentials, region variables, and local invoke mode so AWS SDK clients and Voke resource bindings point at the same local services.

## Serverless Framework Migration

Generate a Voke migration skeleton from an existing `serverless.yml`:

```bash
voke migrate serverless ./serverless.yml --out ./voke-migration
```

The migrator detects service/provider settings, functions, HTTP API and REST API routes, SQS workers, EventBridge workers, environment variables, IAM statements, package patterns, and plugins. It writes route/function skeletons, a stack starter, `MIGRATION_REPORT.md`, and `SERVERLESS_COMPATIBILITY.md` so teams can move one function at a time and keep unsupported plugin/event behavior visible.

See [docs/serverless-framework-migration.md](./docs/serverless-framework-migration.md) and [examples/serverless-migration](./examples/serverless-migration) for common migration shapes.

## E2E Testing

Voke includes helpers for first-class API and AWS integration tests:

```ts
import { createTestClient } from "voke";
import service from "../src/index";

const client = createTestClient(service);
const response = await client.get("/health");
```

Use `createTestClient()` for local Lambda/API Gateway semantics or deployed stack smoke tests, `createStackTestContext()` for CloudFormation outputs, local AWS resource bindings, and Floci seed plans, and `createInvokeTestClient()` for worker flows.

See [docs/e2e-testing.md](./docs/e2e-testing.md) and [examples/e2e](./examples/e2e).

## Common Commands

To install dependencies:

```bash
bun install
```

To run every workspace test:

```bash
bun test
```

To build every workspace:

```bash
bun run build
```

To run the example API in watch mode:

```bash
bun run --filter @voke/hello-api dev
```

Then open:

```bash
curl http://localhost:3000
```

Bun starts the example from its default export because `api()` exposes a `fetch` handler.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
