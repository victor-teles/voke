# Plan 029: Each Function's role and bindings cover only the resources that Function links

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/core/src packages/core/test packages/aws/src packages/aws/test packages/idempotency packages/testing/src examples apps/docs/content/docs docs CONTEXT.md`
> and `git status --short` with the recorded current state. Plans 022–028 land first and change
> some of these files on purpose: 023 and 024 edit `packages/core/src/invoke.ts` (route
> `query`/`headers`, schema typing); 025 edits `packages/core/src/serverless-migration.ts`; 027
> edits the resource loop of `packages/aws/src/cloudformation-synthesis.ts` (retention
> policies); 028 edits the Function loop and the Event Source adapters (dead-letter queues).
> Reconcile that drift: every excerpt below is located by its text, not only by its line
> number. Pause only if drift invalidates a decision listed below.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH (breaking authoring change; a second generic on every handler context; a
  missed link fails closed, as `AccessDenied` or a missing binding)
- **Depends on**: none hard. Ordering only: after
  `.factory/plans/027-data-resource-retention.md` and plan 028 (dead-letter queues), which edit
  the same synthesis loop; after plans 023 and 024, which edit `packages/core/src/invoke.ts`.
  Plan 032 (idempotency) runs after this one and edits `packages/idempotency/src`.
- **Category**: security
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

Voke synthesizes one IAM role per Function, but every role gets the statements of every
resource in `voke.config.ts`, and every Lambda gets every `VOKE_RESOURCE_*` binding. A bug or
an injection in one public route handler can therefore read and write every table, queue,
bucket and secret of the stack. The roles are separate in name only.

After this plan a Function declares the resources it uses (`resources: ["usersTable"]`), reads
them through its handler context (`context.resource("usersTable")`), and its role and
environment hold those resources and no others. A read of a resource the Function did not link
fails the same way under `voke dev`, in tests and on AWS, so the mistake shows before deploy.
It is a breaking authoring change, so it has to land before the first release.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-opinionated-framework.md`: "Each setting has one spelling and each API has
  one name"; removals happen "without deprecation aliases" because the package is unreleased.
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (`packages/core`) is
  provider-neutral and must not import `@voke/*`; `@voke/aws` owns all AWS code.
- ADR `docs/adr/0005-entrypoint-specific-function-authoring-api.md`: Functions are authored with
  `fn`, `http`, `sqs` and the other entrypoint builders, inside `createFunctions({ ... })`.
- ADR `docs/adr/0007-runtime-variables-and-aws-export-boundaries.md`: Runtime Variables are
  declared per Function in a `variables` catalog and read from the handler context, which "lets
  Voke synthesize least-privilege IAM for only the Functions that declare each secret or
  parameter". This plan follows that pattern for resources. The same ADR lists `bindResource`
  as a runtime helper; this plan removes it (decision 2).
- ADR `docs/adr/0015-plugin-contract.md`: "The AWS Provider accepts `awsPolicy({ statements })`,
  IAM statements added to every Function role, matching how resource statements are scoped
  today." Plugin Contributions are static data; a Plugin cannot see the Function Registry when
  it builds them.
- ADR `docs/adr/0017-idempotency-plugin.md`: "Like every resource, every Function role can read
  and write it and every Function gets its binding; per-Function resource linking (roadmap v2
  phase 5) should narrow this."
- `roadmap-v2.md` phase 5 ("Resource Linking and Least-Privilege Permissions") asks for `link`
  or `resources` on every Function builder, typed bindings per Function, runtime tests "proving
  unlinked resources produce helpful errors", a grant escape hatch and a `voke resources`
  command. This plan delivers the first three and defers the last two (decision 13).
- Vocabulary from `CONTEXT.md` to use: **Function**, **Function Registry**, **Gateway**,
  **Event Source**, **Runtime Variable**, **Plugin**, **Plugin Contribution**, **Function
  Wrap**, **Provider**, **Provider Extension Record**. `CONTEXT.md` says resources are
  referenced "by Voke resource key, not by passing the queue resource object" (line 689). This
  plan adds the term **Resource Link** (step 7).

### Code at `1c59d39`

**Every resource's statements reach every role.**
`packages/aws/src/cloudformation-synthesis.ts`:

```ts
// :987
const policyStatements: CloudFormationValue[] = [];
// :993-1010, inside `for (const [name, resource] of Object.entries(model.resources))`
policyStatements.push(
  ...toResourcePolicyStatements(logicalId, resource, provider)
);
// :1013-1014
// Plugin awsPolicy() statements reach every Function role, like resource statements.
policyStatements.push(...pluginPolicyStatements(model));
// :1033-1042, inside the Function loop
templateResources[roleLogicalId] = functionRoleResource([
  ...policyStatements,
  ...toRuntimeVariablePolicyStatements(definition.variables, model.resources),
  ...toEventSourcePolicyStatements(name, definition, model),
  ...durableAccess.statements,
  ...durableExecutionRoleStatements(definition),
]);
```

`toRuntimeVariablePolicyStatements` (`:436-493`) and `toEventSourcePolicyStatements`
(`:496-512`) are already per Function. `toResourcePolicyStatements` (`:370-414`) builds the
statements of one resource from `resource.access.actions`. The Function loop sets one
environment variable per entry of `definition.bindings` (`:1047-1060`).

**Every Function gets every binding.** `packages/core/src/model.ts`:

```ts
// :533-537
const bindings = Object.entries(resources).map(([resource, definition]) => ({
  attribute: definition.binding.attribute,
  env: definition.binding.env,
  resource,
}));
// :596-598, in toModelFunction
return {
  bindings,
```

`VokeModelFunction.bindings: VokeModelBinding[]` (`:111`) is already a per-Function field; it
is only filled with the same array. `validateModel` (`:404-412`) rejects a binding whose
resource is not in `model.resources`. `validateRuntimeVariableResources` (`:459-505`) finds the
resources a Function's Runtime Variables reference: `runtimeVariableResourceKind(variable.source)`
is defined and `variable.source.resource` is a string.

**Reading a binding is ambient and untyped.** `packages/aws/src/resources.ts:27-49`:

```ts
export const bindResource = <TValue extends string = string>(
  name: string,
  attribute: string
): ResourceBinding<TValue> => {
  const envName = createResourceBindingName(name, attribute);
  return {
    attribute,
    envName,
    name,
    value: () => {
      /* reads process.env[envName] */
    },
  };
};
```

It reads `process.env` from anywhere, so it cannot know which Function is running. Under
`voke dev` one process holds every binding
(`packages/aws/src/index.ts:281-305`, `environment: { ...environment, ...bindings }`), so an
ambient read always succeeds locally.

**How resource keys are typed today.** They are not. `bindResource(name: string, ...)`,
`secret.fromResource("signingSecret")`, `sqs({ queue: "ordersQueue" })` and `s3({ bucket })` all
take a plain `string`; a wrong key is a validation error when the model is built
(`model.ts:561-576`, `:481-488`), never a compile error. What is typed is the Runtime Variable
**catalog key**: a builder has `const TVariables extends RuntimeVariableCatalog = Record<never, never>`
(`packages/core/src/invoke.ts:1922-1949`), the handler context is `InvokeContext<TVariables>`
(`:97-103`), and `context.variables.missingKey` is a compile error
(`packages/core/test/invoke-typecheck.ts:41-42`). `defineConfig` returns `VokeConfig`, whose
`resources` is `Record<string, VokeResourceInput>` (`packages/core/src/config.ts:37`), so no
type carries the config's resource keys to the entrypoint.

**The handler context.** `packages/core/src/invoke.ts:97-103`:

```ts
export interface InvokeContext<
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  functionName: string;
  trace: InvokeTrace;
  variables: RuntimeVariableHandles<TVariables>;
}
```

`createInvokeContext(definition, options)` (`:988-1007`) builds it from the definition and from
`activatedFunctionDefinitions.get(definition)`, the activation that `voke(functions, { config })`
stores (`packages/core/src/app.ts:233-240`). Handlers run in four places, each of which calls
`createInvokeContext`: `runLocalFunction` (`:1586`), `runRoute` (`:1225`),
`runRequestAuthorizer` (`:1327`) and `sendEventToFunction` (`:1885`). `runRoute` builds a
context by hand when it has no Function definition (`:1231-1241`).

**Builders copy fields one by one.** `fn()` spreads its input (`invoke.ts:1963-1977`), but
`http()` does not (`:1994-2003`: `authorizer`, `authorizers`, `key`, `kind`, `name`, `routes`,
`synthesis`, `variables`), and neither do the `@voke/aws` builders (for example
`packages/aws/src/sqs.ts:403-417`, which ends with `variables: definition.variables`). A new
option that a builder forgets to copy is silently dropped.

**Activation without a config.** `createInvokeTestClient(functions)`
(`packages/testing/src/index.ts:109-116`) and the registry-only branch of `createLambdaHandlers`
without `config` (`packages/aws/src/lambda-handlers.ts:191-195`) activate a registry with no
config. `voke build` always passes the config (ADR 0015: the generated entry "calls
`createLambdaHandlers(project, { config })`").

**In-process invocation.** `resolveRuntime` (`invoke.ts:936-945`) returns `"local"` unless
`VOKE_INVOKE_RUNTIME` is `aws`, and synthesis never sets that variable (it appears only in
`packages/aws/src/local-provider.ts:230` and `local-aws-emulator.ts:201`, as `"local"`). So in
a deployed Lambda, `functions.invoke("other", payload)` runs the other Function's handler
inside the caller's process, with the caller's role and the caller's environment.

**The SQS consumer depends on the blanket statements.** `sqsEventSourceAdapter`
(`packages/aws/src/sqs.ts:476-512`) has no `roleStatements`. A consuming Function can poll its
queue only because `sqsQueue()` lists `sqs:ReceiveMessage`, `sqs:DeleteMessage` and
`sqs:GetQueueAttributes` (`cloudformation-synthesis.ts:236-241`) and every role gets them. The
Kinesis and DynamoDB stream adapters do have `roleStatements`
(`packages/aws/src/kinesis.ts:391`, `dynamodb-stream.ts:480`). SNS, EventBridge, S3 and
schedule are push sources and need nothing on the Function role.

**The idempotency Plugin** (`packages/idempotency/src/plugin.ts:40-42`) builds its store with
`tableName: () => bindResource(table, "name").value()`; `dynamoDbStore` caches the name after
the first read (`dynamodb-store.ts:147-156`). `idempotentBatch`
(`packages/idempotency/src/batch.ts:35-45`) catches every error of a message and reports a
batch item failure without logging it.

**DynamoDB actions.** `cloudformation-synthesis.ts:136-143`: `GetItem`, `PutItem`,
`UpdateItem`, `DeleteItem`, `Query`, `Scan`.

**Examples.** No example handler reads a binding. `examples/hello-api/src/aws.ts` exports two
`bindResource` handles and nothing imports it. `examples/sqs-events` uses
`idempotentBatch` with the `idempotency()` Plugin in its config. `examples/event-sources` and
`examples/stream-events` only consume their resources as Event Sources.

### Findings checked and dropped or corrected

- Lead "`dynamodbTable` omits `BatchWriteItem`, `BatchGetItem` and `TransactWriteItems`":
  the first two are confirmed missing. `TransactWriteItems` is not needed as an action. The AWS
  guide "Using IAM with DynamoDB transactions"
  (`https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html`)
  says: "Permissions for `Put`, `Update`, `Delete`, and `Get` actions are governed by the
  permissions used for the underlying `PutItem`, `UpdateItem`, `DeleteItem`, and `GetItem`
  operations. For the `ConditionCheck` action, you can use the `dynamodb:ConditionCheckItem`
  permission". So a transaction works today unless it contains a `ConditionCheck`; the missing
  action is `dynamodb:ConditionCheckItem` (decision 12).
- Lead lines `:1007-1009`, `:1014`, `:1033-1035` and `model.ts:533,597`: confirmed as quoted.
- Not in the leads, found while reading: the SQS consumer's dependence on the blanket
  statements, the in-process invocation path, and the fact that no example reads a binding.

## Decisions taken in this plan

1. **One spelling: `resources: ["<resource key>", ...]` on every Function builder.** It is an
   array of resource keys on `fn`, `http`, `sqs`, `sns`, `eventBridge`, `schedule`, `kinesis`,
   `dynamodbStream`, `s3`, `durable` and `requestAuthorizer`. The relationship is called a
   **Resource Link**. Reason: every other reference from a Function to a resource is already
   its key (`queue: "ordersQueue"`, `fromResource("signingSecret")`), and the option mirrors
   `variables`. `link` was the other name the roadmap offered; `resources` matches the config
   field it points into. Reverse: rename the option in the builders and the docs.

2. **One way to read: `context.resource("<resource key>")` returns the binding value** (a table
   name, a queue URL, a topic ARN, a secret id) as a string. `bindResource` and the
   `ResourceBinding` type are removed from `@voke/aws`. Reason: an ambient read cannot be
   checked against the running Function, and it is the reason an unlinked read works locally. A
   function accessor is used instead of a `context.resources.<key>` object because an unlinked
   key must throw a helpful error at run time; on an object that needs a `Proxy`, which also
   throws on `toJSON` and breaks any Plugin that logs the context. `createAwsClientConfig`,
   `createResourceBindingName` and `toEnvKey` stay. Code that runs outside a handler takes the
   value as an argument. Reverse: restore `bindResource` from git history; it would bypass the
   link check again.

3. **Typing: the keys a handler may read are typed from that Function's own `resources`; that
   a key exists in `voke.config.ts` is checked when the model is built, not by the compiler.**
   `resources: ["usersTable"]` makes `context.resource("ordersQueue")` a compile error, and a
   Function without `resources` cannot call `context.resource` at all. A key that is misspelled
   in the link itself is a compile error at the first correct read; a key misspelled the same
   way in both places, or linked and never read, is a `VokeConfigError` from `voke dev`,
   `voke synth`, `voke build` and `voke deploy`, with the same wording as today's Event Source
   check. Reason: nothing types resource keys against the config today (see "Current state"),
   and doing it means a generic `defineConfig`, typed Plugin Contributions (the
   `idempotencyTable` key comes from a Plugin) and a module-augmentation registration line in
   every `voke.config.ts`, which would then also apply to `queue`, `bucket` and `fromResource`.
   That is a cross-cutting change with its own risks and is deferred (maintenance notes).
   Reverse: not applicable; the follow-up narrows the key type in one place.

4. **An unlinked read throws `VokeResourceBindingError` that names the missing link**, in every
   environment. Messages, in the order the checks run:
   - `Function "<key>" does not link resource "<resource>". Add it to the Function: resources: ["<resource>"]`
   - `Function "<key>" reads resource "<resource>" while running in-process inside Function "<entry>", which does not link it. An in-process invocation runs with the caller's role: add resources: ["<resource>"] to "<entry>"`
   - `Function "<key>" reads resource "<resource>", but its Function Registry was activated without a config, so Voke cannot resolve the binding. Create the Gateway with the config: voke(functions, { config })`
   - `Missing resource binding: <VOKE_RESOURCE_...>` (today's message without the word "AWS",
     because core is provider-neutral).

5. **An in-process invocation uses the links of the Function that was entered first.** When
   `functions.invoke` runs a handler in the caller's process, the deployed role and environment
   are the caller's, so a read must be linked by both the running Function and the entry
   Function. Core tracks the entry Function with one `AsyncLocalStorage` from
   `node:async_hooks`. An invocation that leaves the process (the `aws` runtime, or a Function
   the Provider routes through its transport, such as a Durable Function) starts a new entry.
   Reason: without this, a nested read passes locally (the dev process holds every binding) and
   fails on AWS. `node:async_hooks` already ships in deployed bundles through `@voke/aws` and
   `@voke/idempotency`. Reverse: drop the entry check; nested reads then fail only when
   deployed.

6. **An Event Source grants its Function what the trigger needs on the source resource, and
   nothing else.** The SQS adapter gains `roleStatements` with `sqs:ReceiveMessage`,
   `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on its queue. Kinesis and DynamoDB streams
   keep their read statements. SNS, EventBridge, S3 and schedule need none. A handler that also
   sends to its queue, reads the uploaded object or writes the table links the resource.
   Reason: one rule (the trigger gets trigger access; the handler gets what it links), and a
   full implicit link would give an SNS subscriber publish rights on its own topic and a stream
   consumer write access to its table. Reverse: add the Event Source's `resource` to the
   Function's links in `model.ts`.

7. **A Runtime Variable built with `fromResource(key)` keeps working without a link.** The
   Function gets that resource's binding (the AWS Runtime Variable provider reads it,
   `packages/aws/src/runtime-variables.ts:112,125`) and the read statement it gets today. It
   does not make `context.resource(key)` available.

8. **A Plugin Contribution resource is linked like any other resource.** A Function that uses
   `idempotent` or `idempotentBatch` declares `resources: ["idempotencyTable"]`. The Plugin
   reads the table name with `execution.context.resource(table)` once per handler call, so a
   Function that forgot the link fails with the message of decision 4 under `voke dev` and in
   any test that runs through a Gateway with the DynamoDB store. In `idempotentBatch` that
   check runs before the per-message loop, so it fails the invocation instead of becoming
   silent batch item failures. Reason: contributions are static data and cannot name
   Functions, and linking the table to every Function would leave stored handler results
   readable by every role. Reverse: have `createInternalModel` add every Plugin-contributed
   resource key to every Function's links.

9. **`awsPolicy()` statements stay on every Function role.** A Plugin's Function Wrap runs
   around every Function, so that is where its permissions are needed, and the statements are
   written explicitly in `voke.config.ts`. The docs say so. Reverse: add a per-Function filter
   to the record; out of scope.

10. **`http({ routes })` is one Function, so its links cover all its routes.** There is no
    per-route link: a route is not a deployable unit and IAM could not enforce it. A project
    that wants a route isolated puts it in its own `http()` Function. The docs say so.

11. **A link grants the builder's full action list; read-only links are not in this version.**
    The outcome (a Function reaches only what it links) does not need them, and
    `VokeModelResource.access.level` stays as it is. The array form leaves room for a later
    `{ resource, access }` entry. Reverse: not applicable.

12. **`dynamodbTable` gains `dynamodb:BatchGetItem`, `dynamodb:BatchWriteItem` and
    `dynamodb:ConditionCheckItem`.** No `TransactWriteItems` action is added (see "Findings").
    `BatchGetItem` and `BatchWriteItem` as IAM action names were not confirmed against the
    Service Authorization Reference during planning (the page did not load); confirm them
    there before coding:
    `https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazondynamodb.html`.

13. **Deferred:** the `voke resources` command, a per-Function custom-statement escape hatch,
    migration hints that turn Serverless IAM statements into links, and a `config` option for
    `createInvokeTestClient`. None is needed for the outcome.

14. **Model shape.** `VokeModelFunction` gains `links: string[]` (the Function's Resource
    Links, in declaration order, without duplicates). `bindings` becomes per Function: one
    entry per link, then one per resource a Runtime Variable reads, without duplicates.
    `schemaVersion` stays `"1"` (unreleased).

15. **`voke dev` keeps every binding in the process environment.** One process hosts every
    Function, so the check lives in `context.resource`, not in the environment. Reading
    `process.env.VOKE_RESOURCE_*` directly bypasses the check locally and finds nothing when
    deployed; the docs say not to.

## Commands you will need

| Purpose                                         | Command                                     | Expected on success |
| ----------------------------------------------- | ------------------------------------------- | ------------------- |
| One test file                                   | `cd packages/<pkg> && bun test test/<file>` | all pass            |
| Package tests                                   | `cd packages/<pkg> && bun test`             | all pass            |
| Package types (runs the `*-typecheck.ts` files) | `cd packages/<pkg> && bun run typecheck`    | exit 0              |
| All tests (what CI runs)                        | `bun run test`                              | all tasks green     |
| All types                                       | `bun run typecheck`                         | exit 0              |
| Lint and format check                           | `bun run check`                             | exit 0              |
| Format                                          | `bun x ultracite fix`                       | exit 0              |
| Docs samples                                    | `cd apps/docs && bun run test`              | all pass            |

Root `bun test` (single process) is plan 022's subject; use `bun run test`.

## Implementation rules relevant to this plan

- Test-first (`AGENTS.md`): write the failing test of each step before the change.
- Core stays provider-neutral: no AWS action name, no `@voke/*` import in `packages/core/src`.
- `packages/core/src/invoke.ts` and `plugin.ts` are run-time modules bundled into Lambdas; do
  not import CLI code into them. Read environment variables with `readEnv` from
  `./runtime-env`, as `invoke.ts` already does.
- No deprecation alias for `bindResource` (ADR 0007).
- Type tests live in `packages/*/test/*-typecheck.ts`, are compiled by `bun run typecheck`, and
  use `// @ts-expect-error <reason>` on the line that must not compile. Follow
  `packages/core/test/invoke-typecheck.ts:38-47`.
- Errors a user can cause are `VokeError` subclasses with the wording style "expected ...;
  received ..." for config validation (`packages/core/src/plugin.ts`) or a sentence that names
  the fix. Messages never contain binding values.
- CloudFormation logical ids must not change: only role policies and Function environment
  variables differ in the templates.
- Ultracite: no `any`, no barrel files, `for...of`, early returns. Run `bun x ultracite fix`.

## Scope

**In scope** (the only files you should modify):

- `packages/core/src/invoke.ts`, `route-builder.ts`, `authorizers.ts`, `model.ts`, `app.ts`
- `packages/core/src/serverless-migration.ts` (one sentence, step 7)
- `packages/core/test/`: `resource-links.test.ts` (create), `model.test.ts`,
  `invoke-typecheck.ts`, `route-builder-typecheck.ts`, `public-surface.test.ts`,
  `cloudformation.test.ts`, `fixtures/*.json`, and any other test there that the change breaks
- `packages/aws/src/`: `cloudformation-synthesis.ts`, `resources.ts`, `index.ts`, `sqs.ts`,
  `sns.ts`, `eventbridge.ts`, `schedule.ts`, `kinesis.ts`, `dynamodb-stream.ts`, `s3.ts`,
  `durable.ts`, `authorizers.ts`, `plugin-records.ts` (comment only)
- `packages/aws/test/`: `resource-links-synthesis.test.ts` (create), the `*-typecheck.ts`
  files, `fixtures/*.json`, and any other test there that the change breaks
- `packages/idempotency/src/plugin.ts`, `idempotent.ts`, `batch.ts`;
  `packages/idempotency/test/plugin.test.ts`, `batch.test.ts`
- `examples/hello-api/src/aws.ts` (delete), `examples/sqs-events/src/functions.ts`, and the
  tests of any example the change breaks
- Docs: `apps/docs/content/docs/guides/resources.mdx`, `idempotency.mdx`,
  `runtime-variables.mdx`, `kinesis-events.mdx`, `sqs-events.mdx`, `s3-events.mdx`,
  `plugins.mdx`, `functions.mdx`, `testing.mdx`, `local-aws.mdx`;
  `apps/docs/content/docs/reference/errors.mdx`, `packages.mdx`;
  `docs/stable-public-surface.md`, `docs/error-conventions.md`
- `CONTEXT.md`, `docs/adr/00NN-resource-links.md` (create; next free number, 0018 unless plans
  027 or 028 took it)

**Out of scope** (do NOT touch, even though they look related):

- Typing resource keys against `voke.config.ts` (`defineConfig` generics, a registration
  interface). Decision 3.
- Read-only links, `voke resources`, a custom-statement escape hatch, migration hints.
- `durableInvokeAccess` (`packages/aws/src/durable-synthesis.ts`): every Function may start
  every Durable Function. It is invoke permission, not a Resource Link.
- Runtime Variable statements and loading, beyond what step 4 says about duplicates.
- `packages/idempotency/src/dynamodb-store.ts`, record expiry, and logging in `batch.ts`:
  plan 032.
- Retention policies (plan 027) and dead-letter queues (plan 028). Statements plan 028 adds
  through an adapter's `roleStatements` are already per Function; leave them.
- `packages/aws/src/local.ts`, `local-provider.ts`, `testing.ts`: local bindings and
  `createStackTestContext` are unchanged.
- Old ADRs and `roadmap-v2.md`: they are records. The new ADR states what it reverses.
- `.factory/plans/README.md`.

## Git workflow

- Branch: `feature/per-function-resource-links`, from the branch that holds plans 022–028.
- Commit only if the operator authorized it. Subjects are imperative sentences that state the
  outcome, for example "Give each Function only the resources it links".
- Do not push or open a PR unless instructed.

## Steps

### Step 1: The model carries links and per-Function bindings (`packages/core`)

Tests first, in `packages/core/test/model.test.ts` (use `createVokeModel` as the file does; it
has two exact-object expectations near `:94` and `:367` that need the new field):

- Two Functions, two resources, one Function with `resources: ["usersTable"]`: that Function's
  model entry has `links: ["usersTable"]` and one binding; the other has `links: []` and
  `bindings: []`.
- `resources: ["usersTable", "usersTable"]` gives one link and one binding.
- A Function whose Runtime Variable is `secret.fromResource("signingSecret")` and that links
  nothing has `links: []` and one binding, for `signingSecret`.
- `resources: ["usrsTable"]` throws a `VokeConfigError` whose message contains
  `functions.<name>.resources.0` and
  `Function "<name>" links resource "usrsTable", but no matching resource is defined.`
- An entry that is not a non-empty string is the same kind of error:
  `expected a resource key; received <JSON>`.

Change:

- `invoke.ts`: add `readonly resources?: readonly string[]` to `BaseFunctionDefinition`
  (`:405-415`) and `resources?: readonly string[]` to `FunctionDefinitionInputBase`
  (`:487-492`). Make `http()` copy it (`:1994-2003`): `resources: definition.resources`. Types
  get narrower in step 3.
- `model.ts`: add `links: string[]` to `VokeModelFunction` with the doc comment of decision 14. In `toModelFunction` (`:554-613`), collect link issues the way `eventSourceIssues` is
  collected and throw `VokeConfigError.validation`. Build the Function's bindings from its
  links, then from its Runtime Variable resources (reuse the test that
  `validateRuntimeVariableResources` applies), without duplicates. Delete the shared `bindings`
  array (`:533-537`).

**Evidence**: `cd packages/core && bun test test/model.test.ts` passes.

### Step 2: `context.resource` and the entry Function (`packages/core`)

Tests first, in a new `packages/core/test/resource-links.test.ts`. Build registries with
`createFunctions` and a config object with a hand-written resource (copy a `VokeResourceInput`
shape from `packages/core/test/model.test.ts`; core tests must not need `@voke/aws` for this),
compose with `voke(functions, { config })`, and set and restore the one environment variable
each test needs with `try`/`finally` (never replace `process.env`; see plan 022). Cases:

- An invokable Function with `resources: ["usersTable"]` returns `context.resource("usersTable")`:
  the value of `VOKE_RESOURCE_USERS_TABLE_NAME`.
- The same read from a Function that does not link it rejects with `VokeResourceBindingError`
  and the first message of decision 4. Assert it through `functions.invoke`, through a route
  (`gateway.request`), through `functions.sendEvent` for an Event Source Function, and for a
  Request Authorizer Function, so all four run sites are covered. For kinds that need a
  Provider, a hand-built definition object with `kind: "event"` is enough; see how
  `packages/core/test/invoke.test.ts` builds one.
- The variable is unset: the fourth message.
- `outer` links nothing and calls `functions.invoke("inner")`; `inner` links `usersTable` and
  reads it: the second message, naming both Functions. With `outer` linking it too, the read
  succeeds.
- A registry activated without a config (`activateFunctionRegistry(functions, "test")`): the
  third message.
- A routed invocation starts a new entry: give the config a Provider stub whose
  `invoke.target` routes `inner` to a transport that runs `inner`'s handler in-process
  (model it on `packages/core/test/provider-invoke.test.ts`), and assert that `inner`'s read
  succeeds although `outer` does not link the resource.

Change, all in `invoke.ts` unless noted:

- `InvokeContext` gains `resource(key: TResource): string` (step 3 adds the type parameter;
  use `string` for now). Declare it with **method syntax**, not as a function-typed property:
  method parameters are compared bivariantly, so a handler annotated with the plain
  `InvokeContext` still fits a Function with narrower keys. If the linter rejects method
  signatures, keep the method and disable the rule on that line with a comment that says why.
- `FunctionRegistryActivation` (`:828-837`) gains
  `resourceBindings?: Readonly<Record<string, string>>` (resource key to environment variable
  name), and `activateFunctionRegistry` accepts it in its options.
- `app.ts`, in `createGatewayApp` (`:233-239`): add `resourceBindings` to `activation`, built
  from `config.resources` with `createResourceBindingName(key, resource.bindingAttribute)` from
  `./bindings`. `config.resources` already includes Plugin Contributions
  (`config.ts:359`).
- One module-level `AsyncLocalStorage<{ readonly entry: BaseFunctionDefinition } | undefined>`.
  Two helpers: one runs a callback with the definition as entry when no entry is set and
  otherwise just calls it; the other runs a callback with the store set to `undefined`.
- Wrap the handler execution (wraps included) of `runLocalFunction`, `runRoute` (when it has a
  definition), `runRequestAuthorizer` and `sendEventToFunction` in the first helper. Enter the
  scope around the handler call only, not around a whole request: under `voke dev` a Request
  Authorizer Function runs before the route handler and is its own entry, as it is on AWS.
- In `invokeFunction`, wrap the two calls that leave the process (`invokeThroughTransport` for
  a routed Function near `:1823`, and `invokeAws` near `:1851`) in the second helper.
- `createInvokeContext` builds `resource`. It reads the store **when called**, not when the
  context is built. Checks, in order: the definition's `resources` include the key; the
  entry's `resources` include the key when the entry is another definition; the activation has
  `resourceBindings`; the key has an entry there (otherwise the first message is still right:
  the model rejects unknown keys); `readEnv(name)` is a non-empty string.
- The hand-built context in `runRoute` (`:1231-1241`) gets a `resource` that throws the first
  message with the route as the Function name.

**Evidence**: `cd packages/core && bun test test/resource-links.test.ts test/invoke.test.ts test/plugins.test.ts test/node-runtime.test.ts`
passes (`node-runtime.test.ts` loads a bundle under real Node and must still pass with
`node:async_hooks` in core).

### Step 3: Type the keys and carry the option through every builder

Type tests first:

- `packages/core/test/invoke-typecheck.ts`: for `fn` and for `http` with the callback form
  `routes: (route) => [...]`, `resources: ["usersTable"]` allows
  `context.resource("usersTable")` and rejects `context.resource("ordersQueue")`; a Function
  without `resources` rejects any `context.resource(...)` call; a handler declared separately
  as `(payload: ..., context: InvokeContext) => ...` is accepted by `fn({ resources: [...] })`.
- `packages/aws/test/sqs-typecheck.ts`, `event-sources-typecheck.ts`, `stream-typecheck.ts`,
  `s3-typecheck.ts`, `durable-typecheck.ts`: the same two assertions for `sqs`, `sns`,
  `eventBridge`, `schedule`, `kinesis`, `dynamodbStream`, `s3`, `durable`, and for
  `requestAuthorizer` in `invoke-typecheck.ts` (it is already imported there).
- A run-time test, table-driven, in `packages/aws/test/resource-links-synthesis.test.ts`: for
  each of the eleven builders, the definition it returns has `resources` equal to the input.
  This is the guard against a builder that forgets to copy the field.

Change:

- `InvokeContext<TVariables, TResource extends string = string>`.
- Each builder gets `const TResources extends readonly string[] = readonly []` next to
  `TVariables`, takes `resources?: TResources`, and types its handler context as
  `InvokeContext<TVariables, TResources[number]>`. With no `resources` the key type is `never`.
- Thread the parameter only as far as a handler's context needs it: `FunctionHandler`,
  `EventFunctionHandler`, `RouteHandler`, `RouteDefinitionInput`, the definition-input types,
  `Voke<TVariables, TResource>` in `route-builder.ts` (the global `route` keeps the default
  `string`, so the array form `routes: [route.get(...)]` is checked at run time only, as it is
  for Runtime Variables), `RequestAuthorizerHandler` in `authorizers.ts`, and
  `DurableInvokeContext` in `packages/aws/src/durable.ts`. `FunctionDefinitionWithKey`
  (`invoke.ts:548-657`) does not read handler context types and can keep the defaults.
- Every builder that builds its definition field by field copies `resources`.

**Evidence**: `bun run typecheck` in `packages/core`, `packages/aws`, `packages/idempotency`,
`packages/testing` and `packages/openapi` exits 0; the new `@ts-expect-error` lines are used.

### Step 4: Synthesis grants per Function (`packages/aws`)

Tests first, in `packages/aws/test/resource-links-synthesis.test.ts`, with
`synthesizeCloudFormation({ functions, name, resources })` from `@voke/aws/cloudformation` and
the role helpers pattern of `packages/aws/test/stream-synthesis.test.ts:72-78`:

- Two Functions and a table; one links it. The linking Function's role has the table
  statement and its Lambda has `VOKE_RESOURCE_USERS_TABLE_NAME`. The other role has no
  `Policies` property and its Lambda has no `VOKE_RESOURCE_*` variable.
- No role's policy mentions a resource its Function did not link: iterate every role and
  compare the logical ids referenced by its statements with the Function's links.
- An `sqs({ queue: "ordersQueue" })` Function that links nothing has exactly
  `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on the queue ARN, no
  `sqs:SendMessage`, and no queue binding. Linking the queue adds the full list and the
  binding.
- An `s3({ bucket })` Function that links nothing has no bucket statement; with the link it
  has the `ListBucket` and object statements.
- A Function with `secret.fromResource("signingSecret")` and no link has the secret's read
  statement and binding (unchanged behaviour); with the link as well, the statement appears
  once.
- `dynamodbTable()` actions are the nine of decision 12.
- Existing `packages/aws/test/plugins.test.ts:115` ("adds the awsPolicy statements to every
  Function role") stays green unchanged.

Change in `cloudformation-synthesis.ts`:

- Remove the stack-wide resource statements: the `policyStatements.push(...)` in the resource
  loop. Keep a separate array for `pluginPolicyStatements(model)` and reword its comment:
  Plugin statements reach every role on purpose; resource statements do not.
- In the Function loop, build the role from: the statements of each key in
  `definition.links` (through `toResourcePolicyStatements`), the Plugin statements, the Runtime
  Variable statements, the Event Source statements, then the durable ones. Skip a
  resource-backed Runtime Variable statement when that resource is already in `links`.
- `dynamodbTable`: add the three actions and replace the comment above the list (it says Voke
  does not model per-operation access; keep that, drop nothing else).
- `sqs.ts`: add `roleStatements` to `sqsEventSourceAdapter` as in decision 6, with a comment
  like the one on the Kinesis adapter. If plan 028 already added `roleStatements` there, append
  to what it returns.
- `plugin-records.ts`: no behaviour change; make sure its doc comments still say "every
  Function role".

Then update what the change breaks: `packages/core/test/cloudformation.test.ts` (for example
`:488`, "generates resource-specific IAM policy statements for each AWS helper", must link
each resource to keep its meaning), the fixture files under `packages/core/test/fixtures/` and
`packages/aws/test/fixtures/`, and the example synthesis tests. Review each fixture diff: only
role `Policies` and Lambda `Environment.Variables` may change. No logical id, no resource
count other than what plans 027 and 028 introduced.

**Evidence**: `cd packages/aws && bun test` and `cd packages/core && bun test` pass.

### Step 5: Remove `bindResource`; the idempotency Plugin reads through the context

Tests first:

- `packages/core/test/public-surface.test.ts:134-159`: remove `"bindResource"` from the
  `@voke/aws` export list.
- `packages/idempotency/test/plugin.test.ts`: a Function with
  `resources: ["idempotencyTable"]` and a stubbed DynamoDB client (see how
  `dynamodb-store.test.ts` stubs it) resolves the table name from the binding; a Function
  without the link rejects with `VokeResourceBindingError` and the first message of decision
  4, and its handler body does not run; `idempotency({ store: memoryStore() })` needs no link.
  Replace the test at `:265` ("reads its table binding when a wrapped handler first runs") with
  these.
- `packages/idempotency/test/batch.test.ts`: `idempotentBatch` in a Function without the link
  rejects the whole invocation instead of returning batch item failures.

Change:

- `packages/aws/src/resources.ts`: delete `bindResource`, `ResourceBinding` and the now unused
  import. `packages/aws/src/index.ts`: drop both exports.
- `packages/idempotency/src`: the Plugin's Function Wrap receives `execution.context`. For the
  DynamoDB store, put a table resolver in the scope (`IdempotencyScope` gains an optional
  field) that calls `execution.context.resource(table)`. `resolveScope` in `idempotent.ts`
  calls it once per handler call before the first store operation, so the link is checked for
  every Function and not only for the first one that fills the store's cached table name. The
  store's `tableName` function returns the resolved name. `idempotentBatch` calls the same
  resolver before its `for` loop. With `options.store` there is no resolver and no check.
  Keep these edits to the lines that read the binding; plan 032 changes this package next.
- `grep -rn "bindResource" packages examples` and fix every remaining use in tests.

**Evidence**: `cd packages/idempotency && bun test && bun run typecheck`;
`cd packages/core && bun test test/public-surface.test.ts`.

### Step 6: Examples

- `examples/hello-api/src/aws.ts`: delete. Nothing imports it, and no Function of that example
  uses `eventsQueue` or `usersTable`, so no link is added.
- `examples/sqs-events/src/functions.ts`: `settlePayment` gains
  `resources: ["idempotencyTable"]`, with a one-line comment that the Plugin's table is linked
  like any resource. Its test uses `memoryStore()` and stays as it is.
- `examples/event-sources`, `examples/stream-events`, `examples/cross-function`,
  `examples/durable-workflow`, `examples/e2e`: no handler reads a resource; change only tests
  or expectations that the new synthesis breaks.

**Evidence**: `bun run test` is green for every `examples/*` task.

### Step 7: Docs, vocabulary, ADR

Every sample is compiled by Twoslash (`apps/docs/test/samples.test.ts`).

- `guides/resources.mdx`: rewrite "Read a resource from a Function" (`:67-97`) around the
  link and `context.resource`, the example at `:118-168` (use `resources: ["usersTable"]`, the
  callback form `routes: (route) => [...]` and `TableName: context.resource("usersTable")`),
  and "Access each Function gets" (`:173-203`): the table now lists what a link grants, with
  the nine DynamoDB actions; replace the "Access is not scoped per Function" callout with the
  rules of decisions 5, 6, 9, 10 and 15 in plain sentences; say that a key missing from the
  config is an error from `voke dev`, `synth`, `build` and `deploy`.
- `guides/idempotency.mdx`: `:26` and `:280` state every-Function access; say the Function
  links `idempotencyTable`, add `resources` to each sample that uses `idempotent` or
  `idempotentBatch`, and show the error a missing link gives.
- `guides/runtime-variables.mdx:258-262`: remove the "Declared resources are readable by every
  Function" callout; say a `fromResource` variable needs no link.
- `guides/kinesis-events.mdx:254-255`: only a Function that links the stream can produce to
  it. `guides/sqs-events.mdx` ("What gets deployed"): the consumer's role gets the three
  consume actions; sending needs a link. `guides/s3-events.mdx:85-86` and `:160`: reading the
  object needs `resources: ["<bucket>"]`; show it in the sample.
- `guides/plugins.mdx:157`: a contributed resource is linked by the Functions that use it;
  `awsPolicy` statements reach every role.
- `guides/functions.mdx`: add `resources` where the Function options are listed.
  `guides/testing.mdx`: a Function that reads a resource is tested through
  `voke(functions, { config })` with the binding variable set. `guides/local-aws.mdx:20`: the
  dev process holds every binding; `context.resource` still checks the link.
- `reference/errors.mdx:50`: the four messages. `reference/packages.mdx:116`: drop
  `bindResource`. `packages/core/test/public-surface.test.ts:43` reads `resources.mdx`; keep
  whatever it asserts true.
- `docs/stable-public-surface.md:48` and `docs/error-conventions.md:11`.
- `packages/core/src/serverless-migration.ts`, the `serverless-iam-roles-per-function` note
  ("Voke generates one function role policy surface today; ..."): replace with a sentence that
  Voke scopes each role to the resources its Function links, and that per-function statements
  are still not converted automatically. Update the test that pins the text, if any.
- `CONTEXT.md`, under "Language", near **Runtime Variable**:

  ```md
  **Resource Link**:
  A **Function**'s declaration, by resource key, that it uses one of the project's resources. The link gives the Function the resource's binding and gives its role the resource's access.
  _Avoid_: Grant, permission, attachment, resource binding (the binding is the value a link provides)
  ```

  and under "Relationships": a Function reads only the resources it has a Resource Link to; an
  Event Source gives its Function trigger access to the source resource and no Resource Link;
  a Plugin Contribution resource is linked like any other; an in-process invocation runs with
  the Resource Links of the Function that was entered first.

- `docs/adr/00NN-resource-links.md`, titled "A Function reaches only the resources it links".
  Follow the form of `docs/adr/0015-plugin-contract.md`: a short opening paragraph, then
  decisions 1–11 as prose or a list, then a "This decision reverses earlier ones on purpose"
  section with one `_Contradicts ... — but worth reopening because_ ...` item each for ADR
  0015 ("matching how resource statements are scoped today"), ADR 0017 ("every Function role
  can read and write it") and the Runtime Variables ADR (`bindResource` as a runtime helper).
  End with what is not covered: decision 3's compile-time gap and decision 13.

**Evidence**: `cd apps/docs && bun run test` passes.

### Step 8: Gates

Run `bun x ultracite fix`, then `bun run check`, `bun run typecheck`, `bun run test`.

## Test plan

- New: `packages/core/test/resource-links.test.ts` (run-time checks, all four run sites, the
  entry Function, no config, missing variable, routed invocation);
  `packages/aws/test/resource-links-synthesis.test.ts` (per-role statements and bindings, SQS
  consume-only, S3, Runtime Variable overlap, DynamoDB actions, the eleven builders keep
  `resources`).
- Extended: `model.test.ts` (links, bindings, unknown key), the `*-typecheck.ts` files of core
  and `@voke/aws`, `packages/idempotency/test/plugin.test.ts` and `batch.test.ts`,
  `public-surface.test.ts`.
- Updated for the new output: `cloudformation.test.ts`, the CloudFormation fixtures, example
  synthesis tests.
- Patterns to copy: `packages/aws/test/runtime-variable-iam.test.ts` (per-Function IAM
  assertions), `packages/aws/test/stream-synthesis.test.ts` (role helpers),
  `packages/core/test/invoke-typecheck.ts` (type tests).
- Verification: `bun run test`, `bun run typecheck`, `bun run check`.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0.
- [ ] In a synthesized template with two Functions where one links a table, only that
      Function's role names the table and only its Lambda has the binding (asserted by a test).
- [ ] An SQS Event Source Function that links nothing has the three consume actions on its
      queue and no `sqs:SendMessage` (asserted by a test).
- [ ] `context.resource` on an unlinked key rejects with `VokeResourceBindingError` through
      `functions.invoke`, a route, `functions.sendEvent` and a Request Authorizer Function, and
      for a nested in-process invocation whose entry Function lacks the link.
- [ ] A type test shows `context.resource("<unlinked>")` does not compile for `fn`, `http`
      (callback form), each `@voke/aws` Event Source builder, `durable` and `requestAuthorizer`.
- [ ] `grep -rn "bindResource" packages examples apps/docs/content docs/stable-public-surface.md docs/error-conventions.md`
      returns nothing.
- [ ] `grep -rn "every Function gets\|not scoped per Function\|readable by every Function" apps/docs/content`
      returns nothing about resources.
- [ ] `dynamodbTable()` lists nine actions, including `BatchGetItem`, `BatchWriteItem` and
      `ConditionCheckItem`.
- [ ] `CONTEXT.md` defines **Resource Link**; the new ADR exists and names what it reverses.
- [ ] Fixture diffs touch only role `Policies` and Lambda `Environment.Variables`.
- [ ] `git status --short` shows only in-scope paths.

## STOP conditions

Pause dependent work and report when:

- Threading the second type parameter changes what an existing `*-typecheck.ts` file infers
  (for example the SQS message body becomes `unknown`; ADR 0017 records that `sqs()` needed two
  overloads for this) and it cannot be fixed without reordering or removing a public type
  parameter. Steps 1, 2, 4 and 5 can ship with `context.resource(key: string)`; report the
  typing as the open part.
- Plan 028 changed how an SQS consumer gets its permissions, or gave dead-letter resources a
  place in `model.resources`, in a way that conflicts with decision 6.
- A test or example needs access that no link, Event Source or Runtime Variable explains.
  That is an undeclared dependency on the blanket grant: report it, do not link it away.
- `packages/core/test/node-runtime.test.ts` fails because of `node:async_hooks` in core.
- The Service Authorization Reference does not list one of the three DynamoDB actions.
- Removing `bindResource` breaks a caller outside the in-scope paths.

A changed excerpt or a failing fixture alone is a reason to adapt, not to stop.

## Maintenance notes

- **Reviewer focus**: the Function loop of `cloudformation-synthesis.ts` (nothing stack-wide
  left except Plugin and durable statements); the order of checks in `context.resource`; that
  every builder copies `resources`; fixture diffs.
- **Deploy effect**: the first deploy after this change removes statements and environment
  variables from existing roles and Lambdas in place. A Function that relied on the blanket
  grant fails closed, with `AccessDenied` or `Missing resource binding`.
- **Follow-up, compile-time config keys** (decision 3): make `defineConfig` keep its resource
  keys, type Plugin Contribution keys, and narrow the key type used by `resources`, `queue`,
  `bucket`, `topic`, `bus`, `stream`, `table` and `fromResource` in one change. A module
  augmentation can be declared once per TypeScript program, so check programs that include two
  configs (tests, docs samples) first.
- **Follow-up, access levels** (decision 11): `resources` entries can grow an object form with
  `access: "read"`; builders would need separate read and write action lists.
- **Runtime Variables have the same in-process gap** as decision 5 closes for resources: a
  callee's variable is loaded with the caller's role. Not changed here.
- **Observed, not verified**: no synthesized statement lets a Function invoke another
  non-durable Function with `runtime: "aws"` (`lambda:InvokeFunction` appears only in
  `durable-synthesis.ts` and in service permissions). Worth its own check.
- New Event Source adapters must add `roleStatements` for whatever their trigger needs; there
  is no blanket grant to fall back on. New Function builders must accept and copy `resources`;
  the table-driven test in `resource-links-synthesis.test.ts` should list them.
- `voke dev` holds every binding in one process, so only `context.resource` enforces links
  locally. A future per-Function local process would make the environment enforce it too.
