# Plan 019: A Plugin declared in `voke.config.ts` can wrap every Function, extend the Gateway, contribute to the deployment and add CLI commands

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/core/src packages/core/test packages/aws/src packages/aws/test packages/build/src examples/hello-api apps/docs/content docs CONTEXT.md roadmap-v2.md`
> and `git status --short` with the recorded current state. Plans 014 and 018 may land first and
> change `invoke.ts`, `lambda-handlers.ts` and `provider.ts` on purpose (see "Overlap with plans
> 014 and 018"). Reconcile that drift; pause only if it invalidates a protected contract or a
> decision listed below.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (hard). Ordering only: after `.factory/plans/014-open-event-source-contract.md`
  and `.factory/plans/018-durable-functions.md` if they are in flight, because all three edit
  `packages/core/src/invoke.ts` (`activateFunctionRegistry`, `sendEventToFunction`) and
  `packages/aws/src/lambda-handlers.ts` (`resolveProject`, `handlerFor`).
- **Blocks**: `.factory/plans/020-openapi-and-scalar-plugin.md`, `.factory/plans/021-idempotency-plugin.md`
- **Category**: direction
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

Voke has three extension points today: the Provider, Runtime Variable providers and Hono
middleware. None of them can run code around a Function that is not an HTTP route. An invokable
Function, an SQS Function and a Request Authorizer Function have no hook for logging, tracing or
idempotency. None of them lets a package add an HTTP endpoint that is also deployed, a table that
is also provisioned, or a `voke` command. So every integration (API documentation, idempotency,
observability) would have to be built into core or `@voke/aws`.

This plan adds one small, typed **Plugin** contract. A Plugin is declared once, in
`voke.config.ts`, next to the Provider. Plans 020 (OpenAPI and Scalar) and 021 (idempotency) are
the first two Plugins and prove the contract.

## Decision record (read first)

The owner decided on 2026-11-14 that the Plugin contract covers runtime **and** deploy time
(resources, IAM statements, environment variables, CLI commands).

- _Contradicts `roadmap-v2.md`, "Explicit Non-Goals": "Do not introduce a broad plugin API before
  first-party runtime behavior is stable", and its principle "Favor built-in boring defaults over
  plugin ecosystems for critical runtime behavior" — but worth reopening because_ the deploy path
  now works (plans 002–010), the Provider contract has proved that capability objects in
  `voke.config.ts` are a workable extension shape, and the next integrations the owner wants
  (OpenAPI, idempotency) each need runtime hooks plus deploy-time contributions. Without a
  contract they would be hard-wired into core.
- _Contradicts `docs/adr/0007-opinionated-framework.md`: "Each layer keeps exactly one escape
  hatch […] Hono middleware on the Gateway for HTTP behavior" and "New options should be added
  only when a use case cannot be met through the default or the layer's escape hatch" — but worth
  reopening because_ Hono middleware reaches only HTTP routes, and no existing escape hatch can
  add a deployed route, a resource or a command. The Plugin contract is one new supported way,
  not a second spelling: `voke(functions, { middleware })` and `route.use(...)` stay as the direct
  HTTP escape hatch.

The executor records this in a new ADR and revises `roadmap-v2.md` (Step 8).

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`:
  > The core package owns provider-neutral Function, Gateway, config, contract, route, and
  > Provider capability contracts; `@voke/aws` depends on public `voke` and owns the full AWS
  > workflow […] provider-specific data appears in the provider-neutral model through Provider
  > Extension Records that each Provider validates and interprets.
- Core `src` must not import `@voke/*` (turbo rejects the workspace cycle). Core tests resolve
  `@voke/*` through `paths` in `packages/core/tsconfig.json`.
- ADR `docs/adr/0007-opinionated-framework.md`: one spelling per setting, one name per API,
  removals without aliases (the package is unreleased, version `0.0.0`). Owner decision
  (2026-11-14): "The Provider is set only in `voke.config.ts`; `voke()` loses its `provider`
  option." Plugins follow the same rule.
- ADR `docs/adr/0005-entrypoint-specific-function-authoring-api.md`: the Gateway exposes "the same
  activated Function Registry instance that was passed in". `gateway.functions` must stay the
  user's registry object.
- Vocabulary from `CONTEXT.md` (use these exact terms): **Function**, **Function Registry**,
  **Function Contract**, **Gateway**, **Route Builder**, **Provider**, **Provider Capability**
  ("A focused part of a Provider contract"), **Provider Extension Record** ("A provider-keyed
  model record that carries provider-specific data without making the root project model
  platform-specific"), **Event Invocation**, **Request Authorizer Function**, **Dev Function
  Summary**. `CONTEXT.md:296-297` uses "provider plugins" for Runtime Variable providers; this
  plan gives "Plugin" one meaning and rewords those two lines (Step 8).

### Code at `4015c46`

- **Provider shape to mirror**, `packages/core/src/provider.ts:181-191`:
  ```ts
  export interface VokeProvider {
    build?: ProviderBuildCapability;
    deploy?: ProviderDeployCapability;
    diagnostics?: ProviderDiagnosticsCapability;
    invoke?: ProviderInvokeCapability;
    local?: ProviderLocalCapability;
    name: string;
    runtime?: ProviderRuntimeCapability;
    synthesis?: ProviderSynthesisCapability;
    validate?: (model: VokeModel) => void;
  }
  ```
  `ProviderBuildInput` (`provider.ts:101-107`) has `build`, `config`, `entrypoint`, `functions`.
- **Config**, `packages/core/src/config.ts`: `VokeConfig` (`:19-35`) and `VokeConfigInput`
  (`:97-111`) have `provider?`, `resources`, `environment` and no `plugins`. `defineConfig`
  (`:330-351`) is called again on an already normalized config in many places
  (`cli.ts:232`, `cli.ts:407`, `cli.ts:564`, `dev.ts:53`, `dev.ts:105`, `model.ts:503`,
  `app.ts:233`), so anything it does must be idempotent. It copies `resources` and `environment`
  shallowly: `resources: { ...input.resources }`.
- **Where config resources and environment are read**: `model.ts:505` and `model.ts:578`,
  `dev.ts:115` and `dev.ts:129`. Nothing else.
- **Activation**, `packages/core/src/invoke.ts:943-949` and `:990-1030`:
  ```ts
  interface FunctionRegistryActivation {
    activationKey: string;
    variableCache: RuntimeVariableCache;
    unregisteredVariableProviders: "defer" | "error";
    variableOverrides?: RuntimeVariableOverrides;
    variableProviders: readonly RuntimeVariableProvider[];
  }
  export const activateFunctionRegistry = (
    registry: object,
    activationKey: string,
    options: {
      variableOverrides?: RuntimeVariableOverrides;
      variableProviders?: readonly RuntimeVariableProvider[];
    } = {}
  ): void => {
  ```
  It stores the activation per definition object in the `activatedFunctionDefinitions` WeakMap
  (`:955-958`, `:1024-1029`). `createInvokeContext` (`:1048-1067`) reads it back with
  `activatedFunctionDefinitions.get(definition)`.
- **The four places a handler is called** (all in `packages/core/src/invoke.ts`):
  - invokable, `runLocalFunction` `:1614-1641`: `definition.handler(parsedPayload, context)` at
    `:1627`, inside `withTimeout`, after `parsePayload` and before `parseResult`.
  - route, `runRoute` `:1285-1318`: `await handler(request as RouteRequest<…>, context)` at
    `:1312-1315`. `definition` may be `undefined` (`:1291-1302`); then there is no activation.
  - event, `sendEventToFunction` `:1815-1842`: `return await definition.handler(parsedEvent, context)`
    at `:1841`.
  - Request Authorizer, `runRequestAuthorizer` `:1368-1378`: `await handler(request, runtimeContext)`
    at `:1378`.
- **Gateway**, `packages/core/src/app.ts:159-199` (`createGatewayApp`). Order today: the
  `VOKE_CONFIG` middleware (`:166-170`), CORS (`:172-174`), `options.middleware` (`:176-178`),
  `notFound`/`onError`, `assertUniqueFunctionRoutes`, `assertRouteParamSchemas`,
  `activateFunctionRegistry(functions, activationKey(config), { variableOverrides, variableProviders })`
  (`:187-190`), `mountFunctionRoutes(app, functions, config.provider)` (`:191`), and under
  `VOKE_DEV_SUMMARY === "1"` the dev endpoints and `formatDevFunctionSummary(functions)`
  (`:193-196`). `VokeOptions` (`:32-37`) has `config`, `middleware`, `variables`.
- **HTTP routes are deployed from the model.** `packages/core/src/model.ts:598-615` builds
  `apiRoutes` as `{ authorizer?, function, route }` from the registry entries, and
  `@voke/aws` synthesizes one `AWS::ApiGatewayV2::Route` per entry. A route that exists only in
  the Hono app has no API Gateway route and answers 404 when deployed.
- **Model input**, `model.ts:496-503`: `createInternalModel({ ...config, functions })`.
  `assertUniqueHandlerExportNames` runs on the registry keys (`model.ts:528`).
  `config.provider?.validate?.(model)` runs last (`model.ts:675`).
- **CLI project loading**, `packages/core/src/project.ts:81-111`: `loadProject({ config })`
  imports the entrypoint and returns `{ config, entrypoint, functions }`. `cli.ts` uses
  `project.functions` in `build` (`:631-637`), `deploy` (`:668-678`) and `synth` (`:763-772`).
  `voke dev` does not load the project: it runs `bun --hot <entrypoint>` (`dev.ts:125`), and the
  Gateway is composed inside that process.
- **Build**, `packages/aws/src/build.ts:24-39` generates `.voke/build/index.ts`:

  ```ts
  import * as project from "<entrypoint>";
  import { createLambdaHandlers } from "@voke/aws";

  const handlers = createLambdaHandlers(project);
  export const <name> = handlers["<name>"];
  ```

  The export names come from `functionRegistryEntries(input.functions)` (`build.ts:47-53`).

- **Lambda handlers**, `packages/aws/src/lambda-handlers.ts`: `resolveProject` (`:121-152`) takes
  the Gateway from `project.default`, or a bare registry from `project.functions`, which it
  activates itself with `activateFunctionRegistry(functions, "aws-lambda-handlers", { variableProviders: [createAwsRuntimeVariableProvider()] })`.
  A registry-only project (for example `examples/sqs-events`, entrypoint `./src/functions.ts`)
  has **no config at Lambda run time**. `handlerFor` (`:177-211`) throws for a route-backed
  Function when there is no Gateway. `createLambdaHandlers` is at `:218-229`.
- **Handler names**, `packages/core/src/handler-names.ts:78-93`: a key that is not an identifier
  is camel-cased, so `"openapi-docs"` becomes the export `openapiDocs`.
  `packages/aws/src/cloudformation-synthesis.ts:264-273` (`toLogicalId`) turns it into
  `OpenapiDocs`. Deployed names are `${config.name}-${config.stage}-${key}` (`model.ts:529-530`);
  Lambda names accept letters, digits, `-` and `_`, so a key must not contain `.` or `:`.
- **`http()`** returns a frozen definition with `key: ""` and `kind: "route"`
  (`invoke.ts:1938-1962`). `createFunctions` sets `key` on a copy (`invoke.ts:2187-2202`).
- **CLI spec**, `packages/core/src/cli-spec.ts`: `commandSpecs` (`:62-147`) is one static table.
  `formatHelp` (`:154-171`), `formatCommandHelp` (`:173-200`), `cliUsageMessage` (`:202-208`),
  `parseFlags` (`:213-264`) and `assertKnownFlags` (`:311-329`) all read it by command name.
  `runCli` (`cli.ts:810-846`) looks the command up in `commandHandlers` (`cli.ts:627-776`) and
  throws `Unknown command` otherwise. `loadConfigFromFlags` is at `cli.ts:203-220`.
- **AWS IAM**, `packages/aws/src/cloudformation-synthesis.ts:1012-1018`: every Function role gets
  the statements of every declared resource plus its Runtime Variable statements. Per-Function
  records are validated in `packages/aws/src/lambda-settings.ts:113-142` (`functionRecordIssues`,
  record type `"lambda.function"`) and `:203-217` (`validateAwsLambdaModel`).
- **Tests compose a Gateway with an inline config**: `voke(functions, { config: { name: "greeting-api" } })`
  (`packages/core/test/api.test.ts:107`). `createInvokeTestClient` in `packages/testing/src/index.ts:109-115`
  activates a registry without a Gateway.
- **Export pins**: `packages/core/test/public-surface.test.ts` lists every root export of `voke`
  (`:78-108`) and of each `@voke/*` package, every docs page (`teachingSurfaceFiles`, `:21-47`)
  and every first-party example file (`firstPartyExampleFiles`, `:49-59`).
- **Docs samples**: `apps/docs/test/samples.test.ts` fails when a page has a `ts` or `tsx` fence
  that is not marked `twoslash`. Every TypeScript sample on a docs page must be written as
  ` ```ts twoslash ` and must compile. `apps/docs/content/docs/meta.json` lists the pages.

### Overlap with plans 014 and 018 (ordering only)

- Plan 018 adds `invoke?: ProviderInvokeCapability` to the options of `activateFunctionRegistry`
  and a `target` hook to `ProviderInvokeCapability`, and passes `config.provider?.invoke` from
  `createGatewayApp`. This plan adds `wraps` to the **same options object**. Merge both fields.
- Plan 018 routes the deployed durable handler through `functions.invoke`. A Durable Function
  therefore runs in `runLocalFunction`, and the wrap hook of this plan covers it with no
  durable-specific code. Do not add any.
- Plan 014 makes `sendEventToFunction` return the source's own result type and changes
  `handlerFor`'s `"event"` case. Keep the wrap call around whatever the handler call becomes.
- Plan 018 also touches `resolveProject`'s registry-only branch. Step 5 replaces that branch
  when a config is passed; keep plan 018's behaviour for the branch without a config.

## Decisions taken in this plan

1. **One declaration site.** `defineConfig({ plugins: [a(), b()] })`. `voke()` gets no `plugins`
   option. A Plugin is a plain object built by a factory function, like `aws()`.
2. **Contract** (new file `packages/core/src/plugin.ts`; final spelling may be adjusted, the
   shape may not):

   ```ts
   export type FunctionExecutionKind =
     | "authorizer"
     | "event"
     | "invokable"
     | "route";

   export interface FunctionExecution {
     readonly kind: FunctionExecutionKind;
     /** The Function Registry key. */
     readonly functionKey: string;
     /** What the handler receives: the parsed payload, route request, event or authorizer request. */
     readonly input: unknown;
     readonly context: InvokeContext;
     /** `"GET /users/:id"` for a route execution. */
     readonly route?: string;
   }

   export type FunctionWrap = (
     execution: FunctionExecution,
     next: () => Promise<unknown>
   ) => Promise<unknown>;

   export interface PluginRuntimeInput {
     readonly config: VokeConfig;
     /** True only under `voke dev`. */
     readonly dev: boolean;
     /** Every Function of the Gateway: the project's, then the Plugin-contributed ones. */
     readonly functions: readonly (readonly [string, AnyFunctionDefinition])[];
   }

   export interface PluginRuntimeHooks {
     readonly middleware?: readonly MiddlewareHandler<VokeEnv>[];
     readonly wrap?: FunctionWrap;
   }

   export interface PluginRuntimeCapability {
     /** Called once, when the Gateway is composed. */
     setup: (input: PluginRuntimeInput) => PluginRuntimeHooks | undefined;
   }

   export interface PluginContributions {
     readonly environment?: Readonly<Record<string, string>>;
     /** Route-backed Functions only in v1, keyed by a short name. */
     readonly functions?: Readonly<Record<string, RouteFunctionDefinition>>;
     /** One Provider Extension Record per Provider name. */
     readonly provider?: Readonly<
       Record<string, VokeModelProviderExtensionRecord>
     >;
     readonly resources?: Readonly<Record<string, VokeResourceInput>>;
   }

   export interface PluginCommandInput {
     readonly config: VokeConfig;
     readonly cwd: string;
     readonly flags: Readonly<Record<string, string>>;
     readonly positional: readonly string[];
     readonly output: (line: string) => void;
     /** Imports the project entrypoint; includes Plugin-contributed Functions. */
     readonly loadFunctions: () => Promise<
       readonly (readonly [string, AnyFunctionDefinition])[]
     >;
   }

   export interface PluginCommand {
     readonly description: string;
     readonly usage: string;
     readonly flags?: Readonly<Record<string, CliFlagSpec>>;
     readonly run: (input: PluginCommandInput) => Promise<void>;
   }

   export interface PluginCliCapability {
     readonly description: string;
     readonly commands: Readonly<Record<string, PluginCommand>>;
   }

   export interface VokePlugin {
     readonly name: string;
     readonly cli?: PluginCliCapability;
     readonly contributions?: PluginContributions;
     readonly runtime?: PluginRuntimeCapability;
   }
   ```

   `CliFlagSpec` (`{ description; boolean? }`) moves from `cli-spec.ts` to `plugin.ts` so
   run-time code never imports the CLI module; `cli-spec.ts` re-imports it.

3. **`setup` instead of static hooks.** The binding design asked for a `wrap` hook and a
   middleware contribution. Both are returned from one `runtime.setup(input)` call, because a
   Plugin such as OpenAPI needs the Gateway's Functions and the `dev` flag to build its hooks, and
   the config file cannot see the Function Registry. One function, called once per Gateway.
4. **Wrap semantics.**
   - It runs around the handler call only. `input` is the parsed value the handler receives; the
     result returned by `next()` is the handler's result before output validation. Input and
     output validation failures happen outside the wrap in v1.
   - Order: the first Plugin in `plugins` is the outermost.
   - A wrap may return without calling `next()` (short-circuit); the returned value is then
     validated like a handler result. It cannot change `input`: `next` takes no arguments.
   - Calling `next()` twice rejects with an `Error` that names the Plugin, so a handler never
     runs twice by accident.
   - Hooks apply only to Functions of an activated Function Registry. A handler called directly,
     or a registry activated without a config (`createInvokeTestClient(functions)`,
     `createLambdaHandlers({ functions })`), runs without Plugins.
   - With no wraps the handler is called directly, with no extra closure or promise.
5. **Contributions are static data**, created when the factory runs, like Provider options. They
   are merged in `defineConfig`:
   - `resources`: added to `config.resources`. A key that already exists with a **different
     object** is a `VokeConfigError` (`path: "plugins.<name>.contributions.resources.<key>"`).
     The same object is not a conflict; that is what makes `defineConfig(defineConfig(x))` work.
   - `environment`: added to `config.environment`. A key that already exists with a different
     value is a `VokeConfigError`; the same value is not.
   - `provider`: copied to the model as `model.plugins[<plugin name>].provider`, untouched. The
     configured Provider validates and applies the record under its own name and ignores the
     others.
   - `functions`: see decision 6.
6. **Plugin Functions.** A Plugin that needs an HTTP endpoint which is also deployed contributes
   a route-backed Function (`http({ routes })`). v1 accepts `kind: "route"` only; any other kind
   is a `VokeConfigError` that says so. The reason: the deployed handlers for invokable and event
   Functions call `functions.invoke(key)` and `functions.sendEvent(key)` on the user's typed
   registry (`lambda-handlers.ts:170-174`, `:193-199`), which cannot contain Plugin keys.
   - Registry key: `<plugin name>-<function name>`, for example `openapi-docs`. The Plugin name
     must match `^[a-z][a-z0-9-]*$` and the function name `^[a-z][A-Za-z0-9]*$`. The deployed
     Lambda is `${name}-${stage}-openapi-docs`, the handler export `openapiDocs`.
   - A user key equal to a Plugin key is a `VokeConfigError` naming both. A handler-export
     collision (`openapiDocs` and `openapi-docs`) is already reported by
     `assertUniqueHandlerExportNames`.
   - The user's frozen registry is never mutated. One core helper,
     `projectFunctionEntries(functions, config)`, returns the user's entries followed by the
     Plugin entries. Each Plugin definition is copied once with its `key` set and frozen; the copy
     is cached in a `WeakMap` keyed by the contributed definition, so every caller sees the same
     object (activation is stored per definition object).
7. **Where Plugin Functions join** (each is a test in the test plan):

   | Place                                                                             | Change                                                                                                                                         |
   | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
   | `loadProject` (`project.ts`)                                                      | returns `functions` as a plain record built from `projectFunctionEntries`; `build`, `deploy` and `synth` then include them with no more change |
   | `createInternalModel`                                                             | no merge; it receives the record above. It adds `model.plugins` from `config.plugins`                                                          |
   | `createAwsBuildPlan` export names and manifest                                    | no change; it reads `input.functions`                                                                                                          |
   | `createGatewayApp`                                                                | uses the effective entries for route checks, activation, mounting and the Dev Function Summary                                                 |
   | `createLambdaHandlers`                                                            | builds a handler for every effective entry (Step 5)                                                                                            |
   | Dev Function Summary                                                              | lists Plugin Functions under "Route Functions" with their prefixed key                                                                         |
   | Function Contract Artifact and Dev Function Invoke Endpoint                       | unchanged: they read the user's registry, and only invokable Functions have contract entries                                                   |
   | `functions.invoke`, `functions.route`, `functions.sendEvent`, `gateway.functions` | unchanged: Plugin Functions are not part of the typed registry. Tests reach them with `gateway.request(...)`                                   |

8. **Registry-only projects.** `ProviderBuildInput` gains `configPath?: string` (the config file
   the CLI loaded, absent when the config came from flags). When it is set, the generated entry
   imports the config and passes it:

   ```ts
   import * as project from "../../src/functions.ts";
   import config from "../../voke.config.ts";
   import { createLambdaHandlers } from "@voke/aws";

   const handlers = createLambdaHandlers(project, { config });
   ```

   `createLambdaHandlers(project, { config })` with a bare registry composes the Gateway itself
   with `voke(functions, { config })`, so Plugins, Runtime Variable providers and (after plan 018) the Provider's invoke capability all come from the config on one path. With a Gateway
   export it keeps the Gateway and throws a `VokeConfigError` when the Gateway's Plugin names
   differ from the passed config's ("the Gateway was created with a different config than
   voke.config.ts; pass it: voke(functions, { config })"). Without `config` it behaves as today.

9. **Gateway middleware order**: `VOKE_CONFIG`, CORS, Plugin middleware in `plugins` order,
   `options.middleware`, routes.
10. **CLI**: a Plugin with `cli` adds `voke <plugin name> <command>`. Built-in commands win, so a
    Plugin whose name is a built-in command name (or `help`) is rejected in `defineConfig` when it
    declares `cli`. `plugin.ts` holds the reserved list; a core test asserts it equals
    `Object.keys(commandSpecs)` plus `help`.
11. **AWS IAM record**: `@voke/aws` exports `awsPolicy({ statements })`, which returns
    `{ aws: { type: "iam.policy", properties: { statements } } }` for `contributions.provider`.
    A statement is `{ actions: string[]; resources: string[] }`, always `Effect: "Allow"`. The
    statements are added to every Function role, which matches how resource statements are
    scoped today. A resource contributed through `contributions.resources` needs no record: its
    own `actions` already produce IAM.
12. **What a Plugin cannot do in v1** (state this in the guide and the ADR): replace or wrap the
    Provider; edit the synthesized template; change a Function Contract or the handler input;
    contribute invokable, event or authorizer Functions; add flags to built-in commands; see the
    stage or project name when it builds its contributions.

## Commands you will need

| Purpose           | Command                                                                            | Expected on success |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------- |
| Install           | `bun install`                                                                      | exit 0              |
| Core tests        | `cd packages/core && bun test`                                                     | 0 fail              |
| AWS tests         | `cd packages/aws && bun test`                                                      | 0 fail              |
| One test file     | `cd packages/core && bun test test/plugins.test.ts`                                | 0 fail              |
| Package typecheck | `cd packages/core && bun run typecheck` (same in `packages/aws`, `packages/build`) | exit 0              |
| Example           | `cd examples/hello-api && bun test && bun run typecheck`                           | 0 fail, exit 0      |
| Docs samples      | `cd apps/docs && bun run check:samples guides/plugins.mdx`                         | exit 0              |
| Docs tests/links  | `cd apps/docs && bun run test && bun run lint:links`                               | exit 0              |
| Repo gates        | `bun run check && bun run typecheck && bun run test`                               | exit 0              |

None of these ran during planning; planning was read-only. The scripts exist in the root,
package and `apps/docs` `package.json` files at `4015c46`.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): write the failing test, then the smallest change. Core behaviour is
  tested in `packages/core/test/`, AWS behaviour in `packages/aws/test/`.
- Core `src` must not import `@voke/*` and must not name AWS, Lambda, IAM or CloudFormation in new
  types. IAM appears only in `@voke/aws`.
- Run-time code must not use the `Bun` global (plan 002); read environment variables through
  `readEnv` (`packages/core/src/runtime-env.ts`). `plugin.ts` is bundled into Lambda: it must not
  import `cli.ts`, `cli-spec.ts`, `project.ts` or `package.json`.
- Validation errors use `VokeConfigError.validation([{ message, path }])` with the message shape
  `expected <expectation>; received <JSON value>` and paths such as `plugins.0.name`.
- Types before behaviour: `VokeConfigInput.plugins` is `readonly VokePlugin[]`;
  `VokeConfig.plugins` is always an array (empty when absent).
- No new dependencies. No `console.log`. Arrow functions, `for...of`, early returns (Ultracite).
- Keep the no-Plugin path free: no wrap composition, no extra `await`, no allocation per call.
  The repository has no benchmark harness, so guard this with a unit test that the handler is
  called directly when `wraps` is empty, not with a new benchmark tool.
- A Plugin's `cli` code ends up in the Lambda bundle because the config is imported at run time.
  The guide tells Plugin authors to load CLI-only dependencies with `await import(...)` inside
  `run`.

## Scope

**In scope**:

- `packages/core/src/plugin.ts` (create): the types above, name validation, the reserved-name
  list, `projectFunctionEntries`, contribution merging helpers.
- `packages/core/src/config.ts`: `plugins` on `VokeConfigInput` and `VokeConfig`; merge
  contributions in `defineConfig`.
- `packages/core/src/invoke.ts`: `wraps` on `FunctionRegistryActivation` and on the options of
  `activateFunctionRegistry`; the wrap call at the four handler call sites; nothing else.
- `packages/core/src/app.ts`: `createGatewayApp` (setup, middleware, effective entries).
- `packages/core/src/model.ts`: `VokeModel.plugins`, the duplicate-key check.
- `packages/core/src/project.ts`: effective entries in `loadProject`.
- `packages/core/src/provider.ts`: `ProviderBuildInput.configPath`.
- `packages/core/src/cli.ts`, `packages/core/src/cli-spec.ts`: Plugin command dispatch, help,
  `configPath` passed to `build`.
- `packages/core/src/index.ts`: exports.
- `packages/aws/src/build.ts`, `packages/aws/src/lambda-handlers.ts`,
  `packages/aws/src/cloudformation-synthesis.ts`, `packages/aws/src/lambda-settings.ts` (or a new
  `packages/aws/src/plugin-records.ts`), `packages/aws/src/index.ts` (`awsPolicy` export,
  validation call).
- Tests: `packages/core/test/plugins.test.ts` (create), `plugins-typecheck.ts` (create),
  `cli-contract.test.ts`, `build-cli.test.ts`, `model.test.ts`, `project.test.ts`,
  `public-surface.test.ts`; `packages/aws/test/plugins.test.ts` (create), `build.test.ts`,
  `lambda-handlers.test.ts`.
- `examples/hello-api`: one small Plugin file, its use in `voke.config.ts`, a test.
- Docs: `apps/docs/content/docs/guides/plugins.mdx` (create), `meta.json`, `reference/config.mdx`,
  `reference/cli.mdx`, `reference/packages.mdx`, `guides/http-routes.mdx` (one cross-link in the
  middleware section), `docs/stable-public-surface.md`.
- `CONTEXT.md`, a new ADR in `docs/adr/`, `roadmap-v2.md`.
- `.factory/plans/README.md` (status only, unless the coordinator owns it).

**Out of scope**:

- Any first-party Plugin package (plans 020 and 021).
- Hooks around input or output validation, around `functions.invoke` on the caller side, or
  around the remote/`runtime: "aws"` transport.
- Per-Function IAM scoping for Plugin statements (roadmap v2 phase 5, resource linking).
- Plugin-contributed invokable, event or authorizer Functions.
- A Middy adapter (roadmap non-goal that stays).
- `voke create` scaffold changes: the starter gets no Plugin.
- Runtime Variable providers: they keep their own contract (`createVariableProvider`).

## Git workflow

- `origin/main` lacks PRs #53–#62: they were merged into each other's branches. The base is the
  stack tip `origin/feature/docs-site-platform` (`4015c46`), or the branch the previous plan in
  the stack produced.
- Branch: `feature/plugin-contract`. PRs are stacked on the previous plan's branch.
- Commit subjects are imperative sentences ("Let a Plugin wrap every Function execution").
  Commit only if the task authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: Types, config and validation (core)

Create `plugin.ts` with the contract. Add `plugins` to `VokeConfigInput` and `VokeConfig`.
In `defineConfig`:

- validate each Plugin: `name` matches `^[a-z][a-z0-9-]*$`; names are unique; a Plugin with `cli`
  does not use a reserved name; contributed function names match `^[a-z][A-Za-z0-9]*$` and have
  `kind: "route"`;
- merge `contributions.resources` and `contributions.environment` with the identity and equality
  rules of decision 5.

**Evidence**: new tests in `packages/core/test/plugins.test.ts`: a config with a Plugin
normalizes; `defineConfig(defineConfig(input))` equals `defineConfig(input)`; each invalid case
throws a `VokeConfigError` with the documented path; `config.resources` and `config.environment`
contain the contributions.

### Step 2: Function wraps (core)

Add `wraps?: readonly { plugin: string; wrap: FunctionWrap }[]` to the activation and to the
options of `activateFunctionRegistry` (next to plan 018's `invoke?`, if present). Add one internal
helper in `invoke.ts`:

```ts
const runWrapped = (
  definition: BaseFunctionDefinition,
  execution: Omit<FunctionExecution, "functionKey">,
  run: () => Promise<unknown>
): Promise<unknown>
```

It reads the activation with `activatedFunctionDefinitions.get(definition)`, returns `run()`
directly when there are no wraps, and otherwise composes them outermost first with the
double-`next` guard. Call it at `:1627`, `:1312`, `:1841` and `:1378`. In `runRoute` skip it when
`definition` is `undefined`. Keep `withTimeout` outside the wrap in `runLocalFunction`, so a wrap
counts toward the invocation timeout.

**Evidence**: tests that record call order for one invokable, one route (through
`gateway.request` and through `functions.route`), one event (`functions.sendEvent`) and one
Request Authorizer; two Plugins nest in declaration order; short-circuit returns the wrap's value
and still validates it against the output schema; double `next()` rejects; a registry activated
without Plugins calls the handler directly.

### Step 3: Effective entries and the Gateway (core)

Implement `projectFunctionEntries` with the cached keyed copies. In `createGatewayApp`:

1. compute the entries and a plain record of them;
2. call each Plugin's `runtime.setup({ config, dev, functions })`, `dev` being
   `readEnv("VOKE_DEV_SUMMARY") === "1"`;
3. register Plugin middleware after CORS and before `options.middleware`;
4. run `assertUniqueFunctionRoutes`, `assertRouteParamSchemas`, `mountFunctionRoutes` and
   `formatDevFunctionSummary` on the record;
5. activate the user's registry and the record of Plugin definitions with the same activation
   key and options, including `wraps`.

`gateway.functions` stays the user's registry. `mountDevFunctionEndpoints` keeps receiving it.

**Evidence**: a Plugin-contributed `GET /plugin-ping` answers through `gateway.request`; it is
missing from `functions.route` types (`plugins-typecheck.ts` with `@ts-expect-error`); a route
that duplicates a user route fails like two user routes do; `Object.isFrozen(functions)` is
still true and its keys are unchanged; the Dev Function Summary lists the Plugin Function.

### Step 4: Model, project loading and `model.plugins` (core)

`loadProject` returns the effective record. `createInternalModel` adds
`plugins: { [name]: { provider } }` for Plugins that have `contributions.provider`, omits the
field when there are none, and reports a user key equal to a Plugin key. `schemaVersion` stays
`"1"` (the field is additive).

**Evidence**: `model.test.ts`: `model.apis.http.routes` contains the Plugin route with
`function: "<plugin>-<name>"`; `model.functions` has the Plugin Function with deployed name
`${name}-${stage}-<plugin>-<name>`; `model.resources` has the contributed resource;
`model.plugins.<name>.provider.aws` is the record, untouched.

### Step 5: AWS Provider (`@voke/aws`)

- `awsPolicy({ statements })` and validation of `model.plugins[*].provider.aws`: unknown record
  type, empty `actions` or `resources`, or non-string entries are `VokeModelError.validation`
  issues with the path `plugins.<name>.contributions.provider.aws…`. Call it from
  `validateAwsModel` (`packages/aws/src/index.ts`).
- Synthesis: append the Plugin statements to every Function role at
  `cloudformation-synthesis.ts:1012-1018`.
- `createAwsBuildPlan`: import the config in the generated entry when `input.configPath` is set
  and pass `{ config }`. The import path is relative to `.voke/build/`, like the entrypoint's
  (`importPathFromGeneratedEntry`).
- `createLambdaHandlers(project, options?)` as in decision 8. Build handlers from
  `projectFunctionEntries(functions, config)`.
- `cli.ts`: `build(config, { configPath })`; the `build` and `deploy` handlers pass the path
  `loadConfigFromFlags` used when the file exists.

**Evidence**: `packages/aws/test/plugins.test.ts`: the template has an `AWS::Lambda::Function`
and an `AWS::ApiGatewayV2::Route` for the Plugin Function and the contributed resource with its
binding variable on every Function; every role contains the `awsPolicy` statements; an invalid
record fails with the documented path. `build.test.ts`: the generated entry imports the config
only when `configPath` is set, and exports the Plugin handler name. `lambda-handlers.test.ts`: a
registry-only project with `{ config }` runs a wrap around its SQS handler and serves the Plugin
route from an HTTP API event; a Gateway whose Plugins differ from the passed config throws;
`createLambdaHandlers({ functions })` behaves as before.

### Step 6: CLI commands (core)

Give `parseFlags`, `assertKnownFlags`, `formatCommandHelp` and `cliUsageMessage` the spec table
as a parameter that defaults to `commandSpecs`. In `runCli`, when the command is not built in:

1. find `--config` in the arguments, load the config if the file exists (no file: keep today's
   `Unknown command` error);
2. find the Plugin named like the command with a `cli` capability; otherwise `Unknown command`;
3. `voke <plugin>` or `voke <plugin> --help` prints the Plugin description and its commands;
   `voke <plugin> <command> --help` prints that command's usage and flags;
4. parse and check flags against the command's `flags` plus `config`, then call `run`.

`voke --help` lists Plugin commands under a "Plugin commands:" heading when `./voke.config.ts`
loads; a config that fails to load must not break help (catch and list built-ins only).

**Evidence**: `cli-contract.test.ts`: a fixture config with a Plugin command runs it with parsed
flags and positionals; an unknown flag gets the "Did you mean" message; `--help` output at the
three levels; an unknown command without a config file keeps today's message;
`loadFunctions()` returns user and Plugin entries.

### Step 7: Example and exports

- `examples/hello-api/src/plugins/request-timing.ts`: a Plugin whose `wrap` measures the handler
  and whose middleware sets an `x-handler-ms` response header. Add it to
  `examples/hello-api/voke.config.ts` and assert the header in `test/hello-api.test.ts`. Add the
  file to `firstPartyExampleFiles`.
- Root exports of `voke`: the types `VokePlugin`, `PluginRuntimeCapability`, `PluginRuntimeInput`,
  `PluginRuntimeHooks`, `PluginContributions`, `PluginCliCapability`, `PluginCommand`,
  `PluginCommandInput`, `FunctionExecution`, `FunctionExecutionKind`, `FunctionWrap`, and the one
  run-time export `projectFunctionEntries` (a Provider building block, like
  `functionRegistryEntries`). `@voke/aws` gains `awsPolicy`. Update the two lists in
  `public-surface.test.ts` and `docs/stable-public-surface.md`.

### Step 8: Vocabulary, ADR, roadmap and docs

- `CONTEXT.md`: add **Plugin** ("A named unit declared in `voke.config.ts` that extends a Voke
  Project at run time and at deploy time without being a Provider." _Avoid_: middleware,
  extension, Provider plugin), **Function Wrap**, **Plugin Contribution** and **Plugin
  Function**; add the relationships (declared only in config; order is outermost first; Plugin
  Functions are route-backed and outside the typed Function Registry; a Plugin cannot change a
  Function Contract). Reword `:296-297` to "Runtime Variable providers".
- ADR with the next free number at execution time (0010 at planning time; plans 014 and 018 also
  add ADRs; three ADRs share 0007, do not renumber them). It records the two "Contradicts … but
  worth reopening because …" statements above, the contract, and decision 12.
- `roadmap-v2.md`: replace the non-goal at line 356 with "Plugins extend Voke through the typed
  Plugin contract (ADR NNNN); critical runtime behavior stays first-party", adjust the principle
  at line 40 the same way, and point phase 3's "OpenAPI export" and phase 10's "idempotency keys"
  at plans 020 and 021.
- `apps/docs/content/docs/guides/plugins.mdx`: use a Plugin; write one (wrap, middleware,
  contributions, a command); order; testing with `voke(functions, { config: { name, plugins } })`;
  limits. Every TypeScript fence is ` ```ts twoslash ` and compiles
  (`apps/docs/test/samples.test.ts` enforces it). Add `"guides/plugins"` to `meta.json` and the
  page to `teachingSurfaceFiles` in `public-surface.test.ts`. Update `reference/config.mdx`
  (`plugins`), `reference/cli.mdx` (Plugin commands) and `reference/packages.mdx` (new exports).

## Test plan

- `packages/core/test/plugins.test.ts` (new): Steps 1–4 cases. Model it on
  `packages/core/test/api.test.ts` (Gateway composition) and `provider-runtime.test.ts`.
- `packages/core/test/plugins-typecheck.ts` (new): `plugins` accepts a `VokePlugin`; a Plugin
  Function key is not a valid `functions.route`/`functions.invoke` argument; a wrap's `execution`
  is typed. Model it on `invoke-typecheck.ts`.
- `packages/core/test/cli-contract.test.ts`, `build-cli.test.ts`, `project.test.ts`,
  `model.test.ts`, `public-surface.test.ts`: the cases named in the steps, plus the test that the
  reserved-name list equals the built-in command names.
- `packages/aws/test/plugins.test.ts` (new), `build.test.ts`, `lambda-handlers.test.ts`: Step 5.
- `examples/hello-api/test/hello-api.test.ts`: the header assertion.
- Regression: every existing test passes unchanged except the export lists; in particular
  `lambda-handlers.test.ts` cases that call `createLambdaHandlers({ functions })`.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] A Plugin wrap runs around invokable, route, event and Request Authorizer handlers, in
      `plugins` order, and not at all when no Plugin is configured
- [ ] `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth --out <tmp>/t.json`
      exits 0 with the example Plugin configured
- [ ] A Plugin-contributed route is in the synthesized template and is served by
      `createLambdaHandlers` for both a Gateway project and a registry-only project
- [ ] `voke <plugin> <command>` runs, and `voke --help` lists it
- [ ] `VokeOptions` has no `plugins` property: `plugins-typecheck.ts` has a `@ts-expect-error` on
      `voke(functions, { plugins: [] })`
- [ ] The ADR exists; `roadmap-v2.md` no longer lists the Plugin API as a non-goal; `CONTEXT.md`
      defines **Plugin**
- [ ] `cd apps/docs && bun run check:samples guides/plugins.mdx` exits 0
- [ ] `.factory/plans/README.md` row updated by its owner

## STOP conditions

- Importing `voke.config.ts` into the generated entry of a registry-only project makes the
  bundle fail to load under Node (for example a config that reads files at import time in one of
  the examples). Report it; do not fall back to duplicating Plugin wiring inside `@voke/aws`.
- Composing the Gateway inside `createLambdaHandlers` changes the behaviour of an existing
  registry-only test in a way that is not just the activation key.
- Plan 014 or 018 landed a different activation or handler shape than described above and the
  wrap cannot be placed around the handler call without changing their contract.
- A needed capability would let a Plugin change a Function Contract or edit the template. That
  is a new owner decision.

A moved line number or a renamed helper is a reason to adapt, not to stop.

## Maintenance notes

- A Durable Function (plan 018) replays its handler, so a wrap runs once per replay. Plugin
  authors must keep wraps free of side effects that are unsafe to repeat; say so in the guide
  once plan 018 lands.
- Widening Plugin Functions to invokable or event kinds needs a Plugin-owned registry created
  with `createFunctions`, so `invoke` and `sendEvent` exist for those keys.
- Plugin IAM statements go to every Function role. When resource linking (roadmap v2 phase 5)
  scopes roles per Function, give the record a `functions` filter.
- Reviewers should check: `defineConfig` idempotence, that `gateway.functions` is still the
  user's object, and that no run-time module imports CLI code.
- Deferred: validation-failure hooks, an `onError` observation hook, flags on built-in commands,
  Plugin access to the stage when building contributions.
