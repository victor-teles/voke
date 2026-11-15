# Plan 020: `@voke/openapi` generates an OpenAPI 3.1 document from route contracts and serves it with a Scalar API reference page

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/core/src packages/core/test packages/schema packages/remote examples/hello-api apps/docs docs CONTEXT.md roadmap-v2.md README.md`
> and `git status --short` with the recorded current state. Plan 019 lands first and changes
> `packages/core/src` on purpose (see "State after plan 019"). Reconcile that drift; pause only
> if it invalidates a protected contract or a decision listed below.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `.factory/plans/019-plugin-contract.md` (hard: the Plugin contract,
  `runtime.setup`, Plugin Functions and Plugin CLI commands). No other dependency.
- **Category**: dx
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

A Voke route already declares everything an API reference needs: method, path, and schemas for
params, query, headers, body and output. Today that knowledge stays inside the process. A team
that wants API documentation or a typed client has to write an OpenAPI file by hand and keep it
in step with the code. `roadmap-v2.md` lists "OpenAPI export from route contracts" in phase 3 and
as a P1 backlog item.

After this plan, adding `openapi()` to `voke.config.ts` gives a project `/openapi.json` and a
browsable `/docs` page under `voke dev`, and `voke openapi generate` writes the document for CI
and client generators. The same change makes the Function Contract Artifact carry real JSON
Schema for Zod and `@voke/schema` contracts, which it does not today.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0002-standard-schema-function-contracts.md`: Function Contracts accept "Standard
  Schema-compatible validators rather than a Voke-only validation DSL".
- ADR `docs/adr/0007-opinionated-framework.md`: one spelling per setting and one name per API;
  removals happen without deprecation aliases (version `0.0.0`); the supported path includes "the
  `{ data }` and `{ error }` response envelope" and "API Gateway HTTP APIs with payload format
  2.0".
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: specialized helpers live in
  their own `@voke/*` package; `voke` stays provider-neutral. `@voke/openapi` must not depend on
  `@voke/aws`.
- Core `src` must not import `@voke/*`. Core tests resolve `@voke/*` through `paths` in
  `packages/core/tsconfig.json`.
- Vocabulary from `CONTEXT.md`: **Function**, **Function Registry**, **Function Contract**,
  **Function Contract Artifact** ("An implementation-free, JSON-schema-like metadata description
  of one or more Function Contracts"), **Gateway**, **Route Builder**, **HTTP API**, **HTTP
  Authorizer**, **JWT Authorizer**, **Lambda Request Authorizer**, **Authorizer Identity Source**,
  **Default HTTP Authorizer**, **Route Authorizer Override**, **Plugin** (added by plan 019).

### Code at `4015c46`

- **Route definition**, `packages/core/src/invoke.ts:306-332` (`RouteDefinitionInput`): fields
  `authorizer`, `body`, `handler`, `headers`, `middleware`, `output`, `params`, `query`.
  `RouteDefinition` (`:334-368`) adds `method`, `path` and a resolved `middleware`. There is no
  field for a summary, description or tags.
- **Route-backed Function**, `invoke.ts:526-534`: `authorizer?`, `authorizers?`, `routes`.
  The effective authorizer of a route is `route.authorizer ?? definition.authorizer`, and
  `"none"` means public (`routeAuthorizerName`, `invoke.ts:1347-1354`).
- **Authorizer definitions**, `packages/core/src/authorizers.ts:10-22`:
  ```ts
  export interface JwtAuthorizerDefinition {
    readonly audience: readonly string[];
    readonly identitySource: readonly string[];
    readonly issuer: string;
    readonly kind: "jwt";
  }
  export interface LambdaAuthorizerDefinition {
    readonly cacheTtlSeconds: number;
    readonly function: LambdaAuthorizerTarget;
    readonly identitySource: readonly string[];
    readonly kind: "lambda";
  }
  ```
  Identity sources look like `$request.header.Authorization` (`invoke.ts:1341-1345`).
- **How a route answers**, `invoke.ts:1320-1336` (`routeResponse`): a `Response` is passed
  through; `undefined` becomes `204`; any other value is serialized by `json(result)`, which is
  the `{ data }` envelope with status 200 (`packages/core/src/http.ts`, `response.ts:25-29`).
- **Validation errors**, `packages/core/src/app.ts:108-121`: an invalid body, headers, params or
  query answers `400` with `{ error: { message: "Invalid body", issues } }`; an invalid result
  answers `500`. The envelope types are `DataBody` and `ErrorBody` in
  `packages/http/src/index.ts:12-23`:
  ```ts
  export interface ErrorBody {
    error: {
      code?: string;
      details?: unknown;
      issues?: readonly ResponseIssue[];
      message: string;
    };
  }
  ```
- **Path syntax**: `:name` parameters and a trailing `*`. `@voke/aws` converts them for API
  Gateway in `toApiGatewayRouteKey` (`packages/aws/src/cloudformation-synthesis.ts:640-681`);
  optional and regex parameters fail synthesis.
- **JSON Schema today**:
  - `packages/core/src/remote.ts:195-208`:

    ```ts
    const schemaMetadata = (
      schema: StandardSchemaV1 | undefined
    ): JsonSchema => {
      const schemaWithMetadata = schema as
        | (StandardSchemaV1 & {
            jsonSchema?: JsonSchema;
            "~voke"?: { jsonSchema?: JsonSchema };
          })
        | undefined;

      return (
        schemaWithMetadata?.jsonSchema ??
        schemaWithMetadata?.["~voke"]?.jsonSchema ??
        true
      );
    };
    ```

    `packages/remote/src/index.ts:204-217` holds a second copy of the same function.

  - Nothing sets `~voke.jsonSchema`. `@voke/schema` stores only
    `"~voke": { kind, keys?, optional? }` (`packages/schema/src/index.ts:15-19`, `:70-80`).
  - `apps/docs/content/docs/guides/remote-functions.mdx:190-196` documents the result:
    "`@voke/schema` and Zod schemas do not have that property, so their contract entry is `true`".
  - The artifact's `JsonSchema` type (`remote.ts:23-40`) is a subset: `additionalProperties`,
    `const`, `enum`, `items`, `properties`, `required` and a single-string `type`. Generated
    remote types are derived from it (`JsonSchemaType`, `remote.ts:78-102`).

- **Standard JSON Schema** (verified in the installed `zod@4.4.3`,
  `node_modules/.bun/zod@4.4.3/node_modules/zod/v4/core/standard-schema.d.ts:78-108`, and by
  running it):
  ```ts
  interface Converter {
    readonly input: (
      options: StandardJSONSchemaV1.Options
    ) => Record<string, unknown>;
    readonly output: (
      options: StandardJSONSchemaV1.Options
    ) => Record<string, unknown>;
  }
  type Target = "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);
  interface Options {
    readonly target: Target;
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  ```
  The converter is at `schema["~standard"].jsonSchema`. The declaration says a method "May throw
  if conversion is not supported". A Zod object returned
  `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{…},"required":["id"]}`
  for `input({ target: "draft-2020-12" })`. `zod` `^4.4.3` is a `devDependency` of
  `packages/core` and of `apps/docs`.
- **Core's Standard Schema types**, `packages/core/src/standard-schema.ts:32-48`: `StandardSchemaV1`
  declares `vendor`, `version`, `validate` and `types`, and no `jsonSchema`.
- **New-package checklist** (how `@voke/schema` is registered): `packages/schema/package.json`
  (name, `exports: { ".": "./src/index.ts" }`, scripts `build`/`test`/`typecheck`/`clean`/`prepack`/
  `postpack`, `files`, `engines.bun >=1.4.4`, version `0.0.0`), `tsconfig.json` extending the
  root, `README.md`; the workspace glob `packages/*` and `turbo.json` pick it up with no edit;
  `packages/core/tsconfig.json` `paths`; a pinned export list in
  `packages/core/test/public-surface.test.ts`; `docs/stable-public-surface.md`;
  `apps/docs/content/docs/reference/packages.mdx`; `apps/docs/package.json` `devDependencies`
  (Twoslash resolves sample types from `apps/docs`); `README.md:81`; `bun.lock` through
  `bun install`. The scaffold (`packages/core/src/scaffold.ts:29`) lists only `@voke/aws`,
  `@voke/testing` and `voke`; it does not change.
- **Docs samples**: `apps/docs/test/samples.test.ts` fails for any `ts`/`tsx` fence that is not
  marked `twoslash`. Every TypeScript sample on a docs page must be ` ```ts twoslash ` and
  compile.
- **Deploy outputs**: `voke deploy` writes `.voke/outputs/<stage>.json` with `ApiUrl`
  (`docs/adr/0008-deploy-provider-capability.md`).

### State after plan 019 (expected; verify)

- `defineConfig({ plugins: [...] })`; `VokePlugin { name, cli?, contributions?, runtime? }`.
- `runtime.setup({ config, dev, functions })` returns `{ middleware?, wrap? }`; `dev` is true only
  under `voke dev`; `functions` are the Gateway's entries, Plugin Functions included.
- `contributions.functions` accepts route-backed Functions; the registry key is
  `<plugin name>-<function name>`; they are synthesized, built and served like any Function.
- `cli.commands.<name>.run({ config, cwd, flags, positional, output, loadFunctions })` is reached
  as `voke <plugin name> <command>`.

## Decisions taken in this plan

1. **One JSON Schema reader, in core.** `packages/core/src/standard-schema.ts` gains
   `readJsonSchema(schema, io)` where `io` is `"input" | "output"`. It returns a
   `Record<string, unknown>` or `undefined`:
   1. `schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" })`, with a thrown error
      treated as "not available";
   2. else a top-level `jsonSchema` property, the hand-written form
      `remote-functions.mdx` documents today;
   3. else `undefined`.

   The `~voke.jsonSchema` read is removed without an alias: nothing ever set it.
   `StandardSchemaV1` in core gains the optional `jsonSchema` converter in its `~standard`
   props so the read is typed.

2. **`@voke/schema` implements Standard JSON Schema.** This replaces the brief's "fall back to
   the existing `@voke/schema` metadata": that metadata is only `{ kind, keys, optional }` and
   cannot produce a schema for `min`, `max`, `int`, `literal` or `enum`. Each builder supplies its
   own JSON Schema, so `@voke/schema` and Zod take the same path through the reader.
   Supported targets: `draft-2020-12` and `draft-07` (the two the specification strongly
   recommends); any other target throws, as the specification allows. `schema.undefined()`
   throws for every target: JSON has no `undefined`.
3. **The Function Contract Artifact uses the same reader.** Both copies of `schemaMetadata`
   (core `remote.ts` and `@voke/remote`) call `readJsonSchema` and then
   `toContractJsonSchema`, a pure function exported from `voke` that keeps only the keywords the
   artifact's `JsonSchema` type has. A node that uses anything the subset cannot express
   (`anyOf`, `oneOf`, `allOf`, `not`, `$ref`, a `type` array) becomes `true`. Consequence:
   contract fingerprints change for providers that use Zod or `@voke/schema`, and consumers must
   run `voke remote generate` once. Remote invocation already reports that as contract drift.
4. **Route metadata is one neutral field.** `RouteDefinitionInput` gains
   `meta?: RouteMeta`:
   ```ts
   export interface RouteMeta {
     readonly summary?: string;
     readonly description?: string;
     readonly tags?: readonly string[];
     readonly operationId?: string;
     readonly deprecated?: boolean;
     /** Leave the route out of generated documentation. */
     readonly hidden?: boolean;
   }
   ```
   Four flat fields next to `body`, `params` and `handler` would mix documentation with the
   contract; a field named `openapi` would put a Plugin's name in core. The Gateway ignores
   `meta` at run time. Response status and extra response shapes are not part of v1.
5. **Exposure.** `openapi()` serves the document and the page under `voke dev` only (a dev-only
   Gateway middleware returned from `runtime.setup` when `dev` is true). Nothing is deployed.
   `openapi({ expose: true })` instead contributes one route-backed Plugin Function, key
   `openapi-docs`, with `authorizer: "none"` on both routes; it is served locally and deployed.
   An API description is reconnaissance material, so publishing it is an explicit choice.
6. **Scalar is loaded from the CDN, pinned.** The page is a small HTML string:
   ```html
   <div id="app"></div>
   <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@<version>"></script>
   <script>
     Scalar.createApiReference("#app", { url: "/openapi.json" });
   </script>
   ```
   This is Scalar's documented HTML integration (`https://scalar.com/products/api-references/getting-started`
   and `/integrations/html-js`, read 2026-11-14; the docs show version pinning as
   `@scalar/api-reference@1.69.2`). No Scalar npm dependency enters the Lambda bundle. The
   version is one constant in the package, overridable with `scalar: { version }`.
   **Verify before coding**: the current stable version number, and that the pinned
   `…/npm/@scalar/api-reference@<version>` URL serves the standalone browser build.
7. **Command name**: `voke openapi generate [--out openapi.json] [--server <url>]`. Plan 019
   dispatches Plugin commands as `voke <plugin> <command>`, and `voke remote generate` is the
   existing precedent, so there is no bare `voke openapi`.
8. **Document rules** (OpenAPI `3.1.0`, whose schema dialect is JSON Schema 2020-12):

   | Source                                            | Output                                                                                                                                                                                                                                                                                |
   | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `config.name`, options                            | `info.title` (default: the project name), `info.version` (default `"0.0.0"`), `info.description`                                                                                                                                                                                      |
   | route path                                        | `:id` → `{id}`; a trailing `*` → `{proxy}`; every template parameter is a required string `path` parameter                                                                                                                                                                            |
   | `params`, `query`, `headers` schemas (input side) | one parameter per property of the object schema, `required` from the schema's `required`; a schema with no readable JSON Schema adds nothing beyond the template parameters                                                                                                           |
   | `body` schema (input side)                        | `requestBody.required: true`, `content["application/json"].schema`                                                                                                                                                                                                                    |
   | `output` schema (output side)                     | `responses["200"]` with `{ type: "object", properties: { data: <schema> }, required: ["data"] }`; without `output`, `data` is `{}`                                                                                                                                                    |
   | any of `body`/`params`/`query`/`headers`          | `responses["400"]` → `#/components/schemas/Error`                                                                                                                                                                                                                                     |
   | effective authorizer                              | `security: [{ <name>: [] }]`, plus `401` and `403`; `"none"` or no authorizer → `security: []`                                                                                                                                                                                        |
   | every operation                                   | `responses["500"]` → `#/components/schemas/Error`                                                                                                                                                                                                                                     |
   | `definition.authorizers`                          | `components.securitySchemes`: JWT → `{ type: "http", scheme: "bearer", bearerFormat: "JWT" }` with the issuer in `description`; Lambda → `{ type: "apiKey", in: "header" \| "query", name }` from the first `$request.header.<name>` or `$request.querystring.<name>` identity source |
   | `meta`                                            | `summary`, `description`, `tags` (default: the Function Registry key), `operationId` (default: a stable id from key, method and path), `deprecated`; `hidden: true` omits the route                                                                                                   |
   | Plugin Functions whose key starts with `openapi-` | omitted                                                                                                                                                                                                                                                                               |
   | `servers` option, `--server`                      | `servers`; when served with none configured, the request's origin                                                                                                                                                                                                                     |

   `components.schemas.Error` mirrors `ErrorBody`. A top-level `$schema` key is removed from
   embedded schemas. Routes appear in declaration order, so the output is deterministic.
   A handler that returns its own `Response` (for example `created(...)`, status 201) is still
   documented as `200`; the guide states this limit.

9. **Package surface**: `@voke/openapi` exports `openapi` (the Plugin factory) and
   `createOpenApiDocument` (the pure builder the Plugin, the command and tests share), plus the
   types `OpenApiOptions` and `OpenApiDocument`.

## Commands you will need

| Purpose           | Command                                                                                                 | Expected on success  |
| ----------------- | ------------------------------------------------------------------------------------------------------- | -------------------- |
| Install           | `bun install` (updates `bun.lock` for the new workspace package)                                        | exit 0               |
| Package tests     | `cd packages/openapi && bun test`                                                                       | 0 fail               |
| Core tests        | `cd packages/core && bun test`                                                                          | 0 fail               |
| Schema and remote | `cd packages/schema && bun test`; `cd packages/remote && bun test`                                      | 0 fail               |
| Package typecheck | `bun run typecheck` in `packages/openapi`, `packages/core`, `packages/schema`, `packages/remote`        | exit 0               |
| Example           | `cd examples/hello-api && bun test && bun run typecheck`                                                | 0 fail, exit 0       |
| Generate          | `cd examples/hello-api && bun ../../packages/core/src/cli.ts openapi generate --out <tmp>/openapi.json` | exit 0, file written |
| Docs samples      | `cd apps/docs && bun run check:samples guides/openapi.mdx`                                              | exit 0               |
| Docs tests/links  | `cd apps/docs && bun run test && bun run lint:links`                                                    | exit 0               |
| Repo gates        | `bun run check && bun run typecheck && bun run test`                                                    | exit 0               |

None of these ran during planning. `packages/openapi` does not exist yet; its scripts are the
ones every `@voke/*` package has.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`). The builder is a pure function: test it with plain registries, no
  server.
- `@voke/openapi` depends on `voke` only (`workspace:*`). Tests may use `@voke/schema`, `zod` and
  `@voke/aws` (for `createAuthorizers`, `jwtAuthorizer`, `lambdaAuthorizer`) as
  `devDependencies`. No Scalar or OpenAPI library is added.
- Run-time code must not use the `Bun` global. The command writes the file with
  `node:fs/promises`, imported inside `run` so the file-system code is not on the Lambda start
  path.
- The page is built from strings the project controls, but escape them anyway: pass values into
  the inline script with `JSON.stringify` and replace `<` with `<`; HTML-escape the title.
  Send `content-type: text/html; charset=utf-8` and `application/json` respectively.
- Build the document once per Gateway and reuse it; only `servers` depends on the request.
- Core changes stay neutral: `RouteMeta`, `readJsonSchema` and `toContractJsonSchema` name no
  Plugin and no OpenAPI concept.
- Errors: an unsupported route path or a duplicate `operationId` throws a `VokeConfigError` that
  names the route.
- Ultracite style; no `console.log`; no nested ternaries.

## Scope

**In scope**:

- `packages/openapi/` (create): `package.json`, `tsconfig.json`, `README.md`, `src/index.ts`,
  `src/document.ts`, `src/scalar.ts`, `test/document.test.ts`, `test/plugin.test.ts`.
- `packages/core/src/standard-schema.ts` (`readJsonSchema`, `toContractJsonSchema`, the optional
  `jsonSchema` prop), `packages/core/src/invoke.ts` (`RouteMeta` and the `meta` field only),
  `packages/core/src/remote.ts` (`schemaMetadata` only), `packages/core/src/index.ts`.
- `packages/remote/src/index.ts` (`schemaMetadata` only).
- `packages/schema/src/index.ts` (JSON Schema per builder), `packages/schema/test/schema.test.ts`.
- `packages/core/tsconfig.json` (`paths`), `packages/core/test/public-surface.test.ts`,
  `standard-schema.test.ts`, `remote-functions.test.ts`, `route-builder-typecheck.ts`.
- `examples/hello-api`: `openapi({ expose: true })` in `voke.config.ts`, `meta` and an `output`
  schema on two routes, the dependency in `package.json`, tests.
- Docs: `apps/docs/content/docs/guides/openapi.mdx` (create), `meta.json`,
  `guides/http-routes.mdx` (`meta`), `guides/schemas.mdx` (JSON Schema support),
  `guides/remote-functions.mdx` ("Types come from JSON Schema"), `reference/packages.mdx`,
  `reference/cli.mdx`, `apps/docs/package.json` (`@voke/openapi` dev dependency),
  `docs/stable-public-surface.md`, `README.md` (package list).
- `CONTEXT.md`, a new ADR, `roadmap-v2.md` (mark the phase 3 OpenAPI item as delivered here).
- `bun.lock`, `.factory/plans/README.md` (status only, unless the coordinator owns it).

**Out of scope**:

- Response status codes and multiple response shapes per route; a typed `HttpError` class.
- Protecting the exposed page with an authorizer; a self-hosted Scalar bundle.
- Client or SDK generation; Swagger UI or Redoc.
- An AsyncAPI document for Event Sources.
- Widening the Function Contract Artifact's `JsonSchema` subset or the generated remote types.
- Removing the second `schemaMetadata` copy by merging core `remote.ts` and `@voke/remote`.
- Valibot and ArkType test coverage. They work if their schemas expose `~standard.jsonSchema`;
  the guide says so and names what was tested (Zod, `@voke/schema`).

## Git workflow

- `origin/main` lacks PRs #53–#62: they were merged into each other's branches. The base is the
  stack tip `origin/feature/docs-site-platform` (`4015c46`) plus plan 019's branch.
- Branch: `feature/openapi-and-scalar-plugin`, stacked on `feature/plugin-contract`.
- Commit subjects are imperative sentences ("Generate an OpenAPI document from route contracts").
  Commit only if the task authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: The shared JSON Schema reader (core, schema, remote)

1. Tests first, in `packages/core/test/standard-schema.test.ts`: a Zod schema yields its 2020-12
   schema for both sides; a schema whose converter throws yields `undefined`; a hand-written
   schema with a `jsonSchema` property yields it; a schema with neither yields `undefined`.
2. Implement `readJsonSchema` and `toContractJsonSchema`; export both from `voke` (Provider and
   package building blocks, like `readStandardResult`).
3. `@voke/schema`: give `makeSchema` a JSON Schema producer and implement it per builder:
   `string` (`minLength`, `maxLength`), `number` (`type: "number"` or `"integer"`, `minimum`,
   `maximum`), `coerce.number` (input side also accepts a numeric string), `boolean`, `literal`
   (`const`), `enum`, `null`, `array` (`items`), `object` (`properties`, `required` without the
   optional keys, and `additionalProperties` matching what the validator does with unknown keys;
   read `packages/schema/src/index.ts:223-272` to decide), `optional` (the inner schema).
   The rule lists are closures today (`:87-120`), so carry the JSON Schema fragment alongside
   each rule.
4. Switch both `schemaMetadata` copies to the reader plus `toContractJsonSchema`. Update
   `remote-functions.test.ts` and `packages/remote/test/dev-endpoints.test.ts` where they assert
   `true` for a schema that now has a real entry.

**Evidence**: a test that the contract artifact of a Function with a Zod contract has
`{ type: "object", properties: …, required: … }` and that a Zod union becomes `true`;
`packages/schema` tests for each builder and for the unsupported-target throw.

### Step 2: Route metadata (core)

Add `RouteMeta` and `meta?: RouteMeta` to `RouteDefinitionInput`; export the type. No run-time
behaviour changes.

**Evidence**: `route-builder-typecheck.ts` accepts `meta` and rejects an unknown key;
`route-builder.test.ts` shows the definition returned by `route.get(...)` keeps `meta`.

### Step 3: The document builder (`@voke/openapi`)

Create the package from the checklist in "Current state". Implement
`createOpenApiDocument({ name, functions, options })` in `src/document.ts` following decision 8.
`functions` is the entry list plan 019's `setup` and `loadFunctions` provide.

**Evidence**: `test/document.test.ts` covers, each as its own case: path conversion (`:id`, `*`);
template parameters without a `params` schema; params, query and headers from `@voke/schema`
and from Zod; body and output with the `{ data }` envelope; a route without `output`; the `400`
rule; a Default HTTP Authorizer, a Route Authorizer Override and `"none"`; JWT and Lambda
security schemes including a query identity source; `meta` fields, default tags and
`operationId`, a duplicate `operationId` error; `hidden`; omission of `openapi-*` Functions; no
`$schema` inside components; stable output for the same registry. Add one snapshot-free
"whole document" assertion for a three-route registry so the shape is reviewable.

### Step 4: The Plugin and the page

`openapi(options)` returns a `VokePlugin` named `openapi`:

- `runtime.setup`: keep `functions` and `config` for the handlers; when `dev` is true and
  `expose` is not, return a middleware that answers `GET <documentPath>` and `GET <uiPath>` and
  calls `next()` for everything else.
- `contributions.functions`: only with `expose: true`, `{ docs: http({ routes: [...] }) }` with
  both routes `authorizer: "none"`. The handlers read what `setup` stored and fail with a clear
  `VokeConfigError` if `setup` has not run.
- Options: `title`, `version`, `description`, `documentPath` (default `"/openapi.json"`),
  `uiPath` (default `"/docs"`; `false` disables the page), `expose` (default `false`), `servers`,
  `scalar: { version }`. Validate the two paths (start with `/`, differ from each other).
- `cli.commands.generate`: `--out` (default `openapi.json`), `--server`; builds the document from
  `loadFunctions()` and writes it with two-space JSON and a trailing newline; prints
  `Wrote <path> (<n> operations)`.

**Evidence**: `test/plugin.test.ts`: with `expose: true`, `gateway.request("/openapi.json")`
returns the document and `gateway.request("/docs")` returns HTML that references the pinned
Scalar URL and the document path; without `expose` and without the dev flag both answer 404;
with the dev flag set for the test they answer 200; `createVokeModel` for the exposed case
contains the two routes under the Function `openapi-docs`. A CLI test runs
`voke openapi generate --out <tmp>` against a fixture project and parses the file.

### Step 5: Example, registration and docs

- `examples/hello-api`: add the Plugin with `expose: true`, `meta` on two routes and an `output`
  schema on one; assert `/openapi.json` in `test/hello-api.test.ts`. Check whether any example
  test asserts the full list of synthesized Functions and update it for `openapi-docs`.
- Registration: `packages/core/tsconfig.json` `paths`; a `public-surface.test.ts` case "keeps
  OpenAPI helpers in @voke/openapi" pinning `["createOpenApiDocument", "openapi"]`; the new root
  exports `readJsonSchema`, `toContractJsonSchema` and the type `RouteMeta`;
  `docs/stable-public-surface.md`; `README.md`; `apps/docs/package.json`.
- Docs: `guides/openapi.mdx` (add the Plugin; describe a route with `meta`; what each schema
  becomes; exposure and why it is opt-in; `voke openapi generate` in CI; limits; the page needs
  network access to the CDN). Add it to `meta.json` after `guides/http-routes` and to
  `teachingSurfaceFiles`. Rewrite the "Types come from JSON Schema" section of
  `remote-functions.mdx`: Zod and `@voke/schema` contracts now produce typed entries, and
  consumers must regenerate once. Every TypeScript fence is ` ```ts twoslash `.
- `CONTEXT.md`: add **OpenAPI Document** ("The OpenAPI 3.1 description of a Gateway's HTTP API,
  generated from route contracts." _Avoid_: Swagger file, contract artifact) and **API Reference
  Page**; state that it is distinct from the **Function Contract Artifact** (routes versus
  invokable Functions) and that both read JSON Schema through the same reader.
- ADR with the next free number at execution time: Standard JSON Schema as the single source of
  JSON Schema, the artifact's narrowing rule, dev-only exposure by default, Scalar from a pinned
  CDN URL.

## Test plan

- New: `packages/openapi/test/document.test.ts`, `packages/openapi/test/plugin.test.ts`. Model the
  Gateway cases on `packages/core/test/api.test.ts` and the authorizer fixtures on
  `packages/core/test/route-builder.test.ts`.
- Extended: `packages/core/test/standard-schema.test.ts`, `remote-functions.test.ts`,
  `route-builder.test.ts`, `route-builder-typecheck.ts`, `public-surface.test.ts`,
  `cli-contract.test.ts` (the command through `runCli`); `packages/schema/test/schema.test.ts`;
  `packages/remote/test/dev-endpoints.test.ts`; `examples/hello-api/test/hello-api.test.ts`.
- Regression to watch: remote-function tests that depended on `true` contract entries.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] `voke openapi generate` writes a document for `examples/hello-api` with `openapi: "3.1.0"`
      and one operation per non-hidden route
- [ ] The generated document passes an OpenAPI 3.1 validator run by hand once (for example
      Scalar's or Redocly's CLI through `bunx`, not added as a dependency); record the tool and
      result in the PR description
- [ ] `/docs` opened in a browser under `voke dev` renders the reference (manual check; say so in
      the report, with the Scalar version)
- [ ] A Function Contract Artifact for a Zod or `@voke/schema` contract contains a JSON Schema
      object, not `true`
- [ ] `grep -rn '"~voke"?: { jsonSchema' packages/` returns no matches
- [ ] `packages/openapi/package.json` has no dependency other than `voke`
- [ ] `cd apps/docs && bun run check:samples guides/openapi.mdx` exits 0
- [ ] The ADR exists; `CONTEXT.md` defines **OpenAPI Document**
- [ ] `.factory/plans/README.md` row updated by its owner

## STOP conditions

- Plan 019 has not landed, or its `setup`/`contributions.functions`/`cli` shape differs so that
  a Plugin cannot read the Gateway's Functions. Do not add a private side channel into core.
- Passing real JSON Schema through `toContractJsonSchema` breaks generated remote modules or
  the `JsonSchemaType` inference for an existing test in a way that narrowing cannot fix. Keep
  the artifact on the hand-written `jsonSchema` property, ship the reader for OpenAPI only, and
  report it.
- The pinned Scalar CDN URL does not serve a browser build that exposes
  `Scalar.createApiReference`. Use the documented ESM form
  (`import { createApiReference } from "https://cdn.jsdelivr.net/npm/@scalar/api-reference@<version>/esm.js"`)
  and report which was used; stop only if neither works.
- The owner wants the document exposed by default. That reverses decision 5.

## Maintenance notes

- When routes gain response metadata (status codes, error shapes), extend `RouteMeta` or the
  route contract in core first, then the builder.
- `toContractJsonSchema` is the only place that knows the artifact's subset. Widening the subset
  means changing `JsonSchema`, `JsonSchemaType` and the JSON Schema validator in both
  `remote.ts` copies together.
- Bump the Scalar version constant deliberately; check the page by hand after each bump.
- Reviewers should check HTML escaping in `src/scalar.ts`, that nothing is deployed without
  `expose: true`, and that the exposed routes are public on purpose.
- Deferred: an authorizer option for the exposed page, a self-hosted Scalar asset, AsyncAPI for
  Event Sources, Valibot and ArkType coverage.
