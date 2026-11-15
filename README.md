# voke

Voke is a TypeScript framework for AWS Lambda. You declare typed Functions in one entrypoint, run them locally as an API, test them without a server, and deploy them with one command.

> Voke is not published yet, and the package names (`voke`, `@voke/*`) are not final. Until then, try it from this repository (see [Try it](#try-it)).

## Quickstart

Once Voke is published, three commands take you from nothing to a deployed API:

```bash
voke create my-api      # writes the project and runs bun install
cd my-api
bun run deploy          # deploys the dev stage to AWS and prints the API URL
```

A Voke project is a config file and an entrypoint:

```ts
// voke.config.ts
import { aws } from "@voke/aws";
import { defineConfig } from "voke";

export default defineConfig({ name: "hello-api", provider: aws() });
```

```ts
// src/index.ts
import { schema } from "@voke/schema";
import { createFunctions, http, route, voke } from "voke";

import config from "../voke.config";

const functions = createFunctions({
  http: http({
    routes: [
      route.post("/users", {
        body: schema.object({ name: schema.string() }),
        handler: (request) => ({ greeting: `Hello, ${request.body.name}` }),
      }),
    ],
  }),
});

export default voke(functions, { config });
```

## What you get

- **Typed Functions.** A Function has a Function Contract (input and output schemas). Call it with `functions.invoke(...)`, route HTTP to it with the Route Builder, and the types follow. `@voke/schema`, Zod and other Standard Schema validators work.
- **A local Gateway.** `voke dev` runs your API with hot reload. Tests call `gateway.request(...)` or `functions.route(...)` without starting a server.
- **Local AWS.** `voke local` runs your resources on the official AWS Emulator (or Floci) while your code runs in the local Gateway.
- **One-command deploy.** `voke deploy` builds, uploads and deploys a stage through CloudFormation and prints the API URL. Defaults are production-safe.
- **Clear feedback.** Every command says what it did; `voke doctor` explains what is missing.

## Documentation

The documentation lives in `apps/docs` (run it with `bun run --filter @voke/docs dev`):

- Start: [Introduction](apps/docs/content/docs/index.mdx), [Getting Started](apps/docs/content/docs/getting-started.mdx), [Concepts](apps/docs/content/docs/concepts.mdx)
- Guides: [Functions](apps/docs/content/docs/guides/functions.mdx), [HTTP routes](apps/docs/content/docs/guides/http-routes.mdx), [Schemas](apps/docs/content/docs/guides/schemas.mdx), [Authorizers](apps/docs/content/docs/guides/authorizers.mdx), [SQS events](apps/docs/content/docs/guides/sqs-events.mdx), [Runtime Variables](apps/docs/content/docs/guides/runtime-variables.mdx), [Resources](apps/docs/content/docs/guides/resources.mdx), [Calling other projects](apps/docs/content/docs/guides/remote-functions.mdx), [Testing](apps/docs/content/docs/guides/testing.mdx), [Local AWS](apps/docs/content/docs/guides/local-aws.mdx), [Deploy](apps/docs/content/docs/guides/deploy.mdx), [Migrate from Serverless Framework](apps/docs/content/docs/guides/serverless-migration.mdx), [Troubleshooting](apps/docs/content/docs/guides/troubleshooting.mdx)
- Reference: [Config](apps/docs/content/docs/reference/config.mdx), [CLI](apps/docs/content/docs/reference/cli.mdx), [Errors](apps/docs/content/docs/reference/errors.mdx), [Packages](apps/docs/content/docs/reference/packages.mdx)

## Try it

```bash
git clone https://github.com/victor-teles/voke.git
cd voke
bun install
cd examples/hello-api
bun test               # runs in process: no server, Docker or AWS account
```

The example declares a table and a queue, so `bun run dev` needs them running locally first: `bunx voke local start && bunx voke local bootstrap` (Docker and the AWS CLI). See [Local AWS](apps/docs/content/docs/guides/local-aws.mdx).

## Repository

This repository uses Bun workspaces and Turborepo.

- `packages/core`: the `voke` package (Functions, Gateway, config, CLI).
- `packages/aws`: the AWS Provider (`@voke/aws`), plus `@voke/schema`, `@voke/http`, `@voke/testing`, `@voke/remote` and `@voke/build` next to it.
- `apps/docs`: the documentation site.
- `examples/*`: example projects (`hello-api`, `e2e`, `cross-function`, `sqs-events`, `serverless-migration`).
- `docs/adr`: architecture decision records.

Contributor commands:

```bash
bun install
bun run check          # lint and format
bun run typecheck
bun run test           # all packages, and builds the docs site
```

## License

MIT. See [LICENSE](./LICENSE).
