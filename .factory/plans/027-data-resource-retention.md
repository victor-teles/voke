# Plan 027: Tables, buckets and secrets survive a rename, a replacement, a removal from config and `voke remove`

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/aws/src packages/aws/test packages/core/src/cli.ts packages/core/src/cli-spec.ts packages/core/src/provider.ts packages/core/test apps/docs/content/docs docs/adr CONTEXT.md`
> and `git status --short` with the recorded current state. Plans 022–026 land first; plan 026
> edits `packages/core/src/cli.ts` and `cli-spec.ts` (argument checks, working directory) on
> purpose. Reconcile that drift. Pause only if it invalidates a protected contract or a decision
> listed below.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none hard. Ordering only: after `.factory/plans/026-cli-argument-and-cwd-correctness.md`
  (same CLI files). Plans 028 (dead-letter queues) and 029 (per-Function IAM) edit the same
  synthesis loop after this one.
- **Category**: security (data safety)
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

Voke derives each resource's CloudFormation logical id from its key in `voke.config.ts` and
emits no `DeletionPolicy`. Renaming `users` to `usersTable`, changing a table's `partitionKey`,
deleting the entry, or running `voke remove` therefore makes CloudFormation delete the populated
table, bucket or generated secret. Nothing warns first: the deploy pre-flight only looks at
Lambda replacements.

After this plan, the resources that hold data are retained by default, `voke deploy` refuses a
change set that would remove or replace one unless the user passes `--accept-data-loss`, and
`voke deploy` and `voke remove` name every resource they left behind with the command that
deletes it.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-opinionated-framework.md`: "one supported way per layer", one spelling per
  setting, removals without deprecation aliases, and "Each layer keeps exactly one escape hatch
  […]: raw CloudFormation resource definitions in config for infrastructure".
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (core) is
  provider-neutral and must not import `@voke/*`; `@voke/aws` owns all AWS code.
- ADR `docs/adr/0008-deploy-provider-capability.md`: "The CLI owns what is the same for every
  Provider: resolving the stage […], asking for confirmation before `remove` […]. The Provider
  owns packaging, uploads, stack changes and their progress." Provider failures are
  `VokeDeployError` (code `DEPLOY_ERROR`).
- ADR `docs/adr/0009-aws-emulator-local-provider.md`: local resources run in an emulator and
  are provisioned by `voke local bootstrap`.
- ADR `docs/adr/0014-durable-functions.md`: each Durable Function's `AWS::Lambda::Version` has
  `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`. Leave that as it is.
- Vocabulary (`CONTEXT.md`): **Provider**, **AWS Provider**, **Local AWS Provider**,
  **Function**, **Plugin**, **Provider Extension Record**, "Voke resource key". Entries have the
  form `**Term**:` / one-sentence definition / `_Avoid_: …`.

### Code at `1c59d39`

- **Resource loop**, `packages/aws/src/cloudformation-synthesis.ts:993-1010`:

  ```ts
  for (const [name, resource] of Object.entries(model.resources)) {
    const logicalId = toLogicalId(name);
    const provider = resourceProvider(resource);

    templateResources[logicalId] = {
      Metadata: {
        VokeBinding: {
          Attribute: resource.binding.attribute,
          Resource: name,
        },
      },
      Properties: withDerivedVisibilityTimeout(model, name, resource),
      Type: provider.cloudFormationType,
    };
  ```

  No `DeletionPolicy`, no `UpdateReplacePolicy`. The template type already allows both
  (`packages/aws/src/cloudformation-template.ts:29-30`). The only use today is the durable
  version (`packages/aws/src/durable-synthesis.ts:136-141`).

- **Builders**, same file: `dynamodbTable` (`:109`), `kinesisStream` (`:178`), `sqsQueue`
  (`:232`), `snsTopic` (`:253`), `eventBus` (`:264`), `s3Bucket` (`:275`), `secret` (`:291`,
  `GenerateSecretString: {}`), `ssmParameter` (`:304`). All go through
  `awsCloudFormationResource` (`:81-102`), which copies four fields into
  `provider.aws.properties` (`bindingValue`, `cloudFormationType`, `outputName`,
  `policyResource`). `resourceProvider(resource)` (`cloudformation-template.ts:61-75`) reads
  that record as `AwsCloudFormationResourceProvider`.
- **No builder sets a physical name** (no `TableName`, `BucketName`, `QueueName`, `Name`). The
  resources guide says "AWS generates the physical names"
  (`apps/docs/content/docs/guides/resources.mdx:57`).
- **Raw resource definitions (the escape hatch)** are hand-written `VokeResourceInput` objects
  (`packages/core/src/config.ts:73-87`) without a `provider` key. `toModelResource`
  (`packages/core/src/model.ts:296-329`) then builds `provider.aws.properties` from the four
  flat fields. Example: `packages/core/test/model.test.ts:240-265`.
- **Synthesis options**, `cloudformation-synthesis.ts:938-949`: `{ artifact?, lambda?, scope? }`.
  Call sites: `packages/aws/src/index.ts:296` and `:320` (`{ lambda }`),
  `packages/aws/src/deploy.ts:545` (`{ artifact, lambda }`), `packages/aws/src/local.ts:210`
  (Floci bootstrap, full template) and `:429` (AWS Emulator bootstrap, `{ scope: "resources" }`).
- **Provider options**, `packages/aws/src/index.ts:246-254`: `aws({ lambda?, local? })`. The
  `lambda` value is closed over and passed to synthesis and to `deployAwsStack`
  (`index.ts:264-277`).
- **Deploy pre-flight**, `packages/aws/src/deploy.ts:339-351`, checks only named Lambdas:
  ```ts
  const namedFunctionReplacements = (
    description: ChangeSetDescription
  ): string[] =>
    description.changes.filter(
      (change) =>
        change.resourceType === "AWS::Lambda::Function" &&
        change.replacement === "True"
    );
  ```
  `deployStack` (`:354-410`) prints these as `Warning:` lines on a dry run, and otherwise
  deletes the change set and throws `VokeDeployError` before executing.
- **Change set data**, `packages/aws/src/deploy-clients.ts:22-28`: a change has `action`,
  `logicalId`, `replacement?`, `resourceType`. The mapping is at `:173-192`. The installed SDK
  (`@aws-sdk/client-cloudformation` 3.1169.0) also returns `ResourceChange.PolicyAction`
  (`Delete`, `Retain`, `Snapshot`, `ReplaceAndDelete`, `ReplaceAndRetain`, `ReplaceAndSnapshot`)
  and `ResourceChange.PhysicalResourceId`; `ExecuteChangeSetInput` has `RetainExceptOnCreate`
  ("newly created resources are deleted when the operation rolls back. This includes newly
  created resources marked with a deletion policy of `Retain`"); `ResourceStatus` includes
  `DELETE_SKIPPED`. All four were read in the SDK's type files.
- **Stack events**, `deploy-clients.ts:37-44`: `{ id, logicalId, reason?, resourceType, status,
timestamp }`; no physical id. `describeStackEvents(name)` returns `[]` for a missing stack
  (`:216-238`). `describeStack` returns the stack ARN as `id` (`:193-215`).
- **Remove**, `deploy.ts:587-602`: `describeStack`, print `Removing stack <name>`,
  `deleteStackAndWait` (`:192-210`). A failed delete reports
  `Could not delete stack …: <logical id> (<type>) failed: <reason>. Fix or empty that resource, then run voke remove again.`
- **Provider contract (core)**, `packages/core/src/provider.ts:84-97`: `ProviderDeployInput`
  has `config`, `model`, `artifactDirectory`, `artifactFiles`, `stage`, `region?`, `dryRun`,
  `output`. `ProviderRemoveInput` (`:108-113`): `config`, `stage`, `region?`, `output`.
- **CLI (core)**: flags come from one table, `packages/core/src/cli-spec.ts`; `deploy` is at
  `:80-91` (`--dry-run` only), `remove` at `:126-134`. The `deploy` handler
  (`packages/core/src/cli.ts:685`) calls `deployProject` (`:409-464`), which builds the
  `ProviderDeployInput` at `:446-455`. `removeProject` (`:480-535`) confirms, calls the
  Provider, then prints `Removed <name>-<stage>`.
- **The config file does not know the `--stage` flag.** The stage is resolved after the config
  module has run (`cli.ts:325-326`), and applied with
  `defineConfig({ ...options.config, stage: options.stage })` (`cli.ts:427`). A value computed
  inside `voke.config.ts` from `process.env.VOKE_STAGE` is wrong under `--stage`.
- **Local workflow**: `voke local bootstrap` runs `aws cloudformation deploy` against the
  emulator (`packages/aws/src/local-aws-emulator.ts:150-166`,
  `packages/aws/src/local-provider.ts:185-202`). Teardown is `voke local reset`, which restarts
  the emulator with empty state. Floci binds a resource by its logical id
  (`packages/aws/src/local.ts:116-138`), so there a retained resource would keep its name and
  block a later create with the same key.
- **Template fixtures compared with `toEqual`** that contain a table or a bucket:
  `packages/aws/test/fixtures/stream-event-sources-cloudformation.json`,
  `packages/aws/test/fixtures/s3-event-sources-cloudformation.json`,
  `packages/core/test/fixtures/resources-cloudformation.json`. Also
  `packages/aws/test/resources-only-synthesis.test.ts:52-54` asserts a table's `Metadata`.
- **Docs**: `apps/docs/content/docs/guides/deploy.mdx:112-118` ("Remove a stage"),
  `guides/resources.mdx`, `reference/cli.mdx:111-132` (deploy) and `:296-317` (remove),
  `reference/config.mdx:133-164` ("`aws()` … takes two options"),
  `guides/troubleshooting.mdx:174-184` (the Lambda replacement entry, the model for a new one),
  `getting-started.mdx:88`.

### What CloudFormation does (planner's knowledge; the SDK facts above are verified)

- `DeletionPolicy` applies when a resource leaves the template or the stack is deleted;
  `UpdateReplacePolicy` applies to the old physical resource when an update replaces it. They
  are separate: set both.
- When a resource is removed from the template, the policy that applies is the one in the
  **deployed** template. A stack deployed before this plan has no policy, so a resource removed
  in the first deploy after the upgrade is still deleted.
- A retained resource with a generated name becomes an orphan: it exists, is billed, and no
  stack tracks it. A retained resource with a fixed name blocks the next create of that name.
  Voke's builders generate names, so the orphan case is the one that occurs.
- On a rollback of a create, `Retain` also keeps the half-created resource unless
  `RetainExceptOnCreate` is true.
- CloudFormation's guide says a `DeletionPolicy` cannot be updated by itself, only together
  with another change, and names a `Metadata` change as one way. Not verified against AWS.
- Deleting a non-empty bucket fails; a retained bucket is skipped, so the stack delete succeeds.

### Findings checked and dropped

None dropped. Two adjustments to the audit leads:

- The lead said this plan touches `packages/core/src/model.ts`. It does not: the retention
  marker travels in the AWS Provider Extension Record that `model.ts` already copies untouched.
- The index note lists queues with tables and buckets. A queue is not retained (decision 1).

## Decisions taken in this plan

1. **Data-bearing resources are `dynamodbTable()`, `s3Bucket()` and `secret()`.** The rule: the
   resource holds state that exists nowhere else and that a redeploy cannot recreate. A
   generated secret value qualifies. Not data-bearing: `sqsQueue()` and `kinesisStream()`
   (records in transit with a bounded lifetime; a retained queue has no consumer, and a
   retained stream is billed by the hour), `snsTopic()` and `eventBus()` (no stored data),
   `ssmParameter()` (its value is in the config). _Reverse_: add or remove
   `dataBearing: true` on a builder and the type in `dataBearingTypes`.
2. **Default: retain on every stage.** A data-bearing resource created by a builder gets
   `DeletionPolicy: "Retain"`, `UpdateReplacePolicy: "Retain"` and `Metadata.VokeRetain: true`.
   The metadata entry makes a policy change a detectable template change. _Reverse_: change the
   default of `retainData`.
3. **One opt-out spelling: `aws({ retainData })`.** Type:
   `boolean | ((resource: { key: string; stage: string; type: string }) => boolean)`, default
   `true`. `key` is the Voke resource key, `type` the CloudFormation type.
   ```ts
   provider: aws({ retainData: ({ stage }) => stage === "prod" }),
   ```
   Reason: retention must be decided with the resolved stage, and `voke.config.ts` cannot see
   `--stage` (see "Current state"). A builder option such as `dynamodbTable({ retain: false })`
   would be stage-blind and would push projects to read `VOKE_STAGE` by hand. The predicate
   also covers a single resource (`({ key }) => key !== "cacheBucket"`). There is no builder
   option and no CLI flag for retention. _Reverse_: add a builder option that the predicate
   default reads; the marker in decision 4 already identifies the resource.
4. **The marker lives in `@voke/aws` only.** `awsCloudFormationResource` gains
   `dataBearing?: true`, stored in `provider.aws.properties.dataBearing` and typed on
   `AwsCloudFormationResourceProvider`. Core is unchanged.
5. **Raw resource definitions pass through untouched.** A hand-written `VokeResourceInput` has
   no marker and gets no policy and no metadata, whatever its type. The deploy pre-flight still
   guards it, because that check reads types from the change set (decision 7).
6. **Local templates carry no retention.** `SynthesisOptions` gains `retainData`; the two
   bootstrap call sites in `local.ts` pass `false`. Local data is disposable and a retained
   resource in Floci would block a later create. `voke synth` and `voke deploy` use the
   Provider's `retainData`.
7. **Pre-flight: `voke deploy` refuses to remove or replace a resource of a data-bearing
   type.** It refuses a change whose `resourceType` is in `dataBearingTypes` and whose action
   is `Remove`, or `Modify` with `replacement` `"True"` or `"Conditional"`. It refuses whether
   the resource would be kept or deleted, because in both cases the Functions lose their data:
   they are bound to a new, empty resource or to none. The message says which of the two
   happens, from `PolicyAction`: `Retain` and `ReplaceAndRetain` mean kept; any other value,
   or none, is reported as deleted. _Reverse_: narrow the filter to the deleted cases.
8. **One override: `voke deploy --accept-data-loss`.** It is a per-run flag, never a config
   setting. Core passes it to the Provider as `ProviderDeployInput.acceptDataLoss: boolean`.
   `--dry-run` never refuses; it prints the same lines as `Warning:`.
9. **`RetainExceptOnCreate: true` on every change set execution**, so a failed deploy that
   rolls back does not leave new, empty retained resources behind.
10. **`voke remove` needs no new flag and never deletes retained data.** It deletes the stack,
    then lists what CloudFormation skipped (`DELETE_SKIPPED` events of data-bearing types),
    each with its physical id and a delete command. The explicit way to destroy a stage's data
    with the stack is: set `retainData` to `false` for it, `voke deploy`, then `voke remove`.
    _Reverse_: a `voke remove --delete-data` that deletes the listed resources itself; that
    needs DynamoDB and bucket-emptying code and is deferred.
11. **Adoption is manual.** Voke adds no import command. The docs give three paths: delete with
    the printed command; copy the data into the new resource and then delete; or CloudFormation
    resource import for a user who wants the stack to manage the old resource again.
12. **The idempotency Plugin's table is retained like any other table.** `packages/idempotency`
    is not edited. A project that wants it deleted uses the predicate.
13. **Message text** (tests and docs use these strings):
    - Per resource, `<LogicalId> (<Type>, <physical id>)` followed by one of:
      - `would leave the stack. It is kept with its data, but no Function is bound to it afterwards.`
      - `would be DELETED with its data.`
      - `would be replaced by a new, empty resource. The old one is kept with its data, outside the stack.`
      - `would be replaced by a new, empty resource. The old one is DELETED with its data.`
    - Refusal, first line: `Deploying <stack> would remove or replace <n> resource(s) that hold data:`;
      last lines: `Nothing was changed. A resource key, and a table's partitionKey and sortKey, identify the resource: undo the rename or key change to keep using it.`
      and `To go ahead anyway, run voke deploy again with --accept-data-loss.`
    - Kept block (after an accepted deploy and after `voke remove`):
      `Kept <n> resource(s) that hold data. No stack manages them and AWS still bills them:`
      then per resource `  <Type>  <physical id>` and `    delete with: <command>`.
    - Delete commands: `aws dynamodb delete-table --table-name <id> --region <region>`,
      `aws s3 rb s3://<id> --force --region <region>`,
      `aws secretsmanager delete-secret --secret-id <id> --region <region>`.

## Commands you will need

| Purpose           | Command                                                                                                                                  | Expected on success |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| AWS package tests | `cd packages/aws && bun test`                                                                                                            | 0 fail              |
| One AWS test file | `cd packages/aws && bun test test/deploy.test.ts`                                                                                        | 0 fail              |
| Core CLI tests    | `cd packages/core && bun test test/deploy-cli.test.ts test/cli-contract.test.ts test/cloudformation.test.ts test/public-surface.test.ts` | 0 fail              |
| Package typecheck | `bun run typecheck` in `packages/aws` and `packages/core`                                                                                | exit 0              |
| Docs samples      | `cd apps/docs && bun run check:samples guides/resources.mdx`                                                                             | exit 0              |
| Docs tests, links | `cd apps/docs && bun run test && bun run lint:links`                                                                                     | exit 0              |
| Repo gates        | `bun run check && bun run typecheck && bun run test`                                                                                     | exit 0              |
| Format            | `bun x ultracite fix`                                                                                                                    | exit 0              |

The repo gates ran green at `1c59d39`. `check:samples` with a file argument is the form plan
021 used; it did not run during planning.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): each step starts with a failing test.
- No AWS calls in tests. Deploy tests use the fake clients in `packages/aws/test/deploy.test.ts`
  (`createFakeClients`, `Scenario.changes`); extend the fake, do not replace it.
- `packages/core/src` changes are limited to `provider.ts`, `cli.ts` and `cli-spec.ts`, and
  must stay provider-neutral: no AWS word in a core name, type or message.
- Keep the edit to the synthesis resource loop inside the `templateResources[logicalId] = { … }`
  literal plus one helper call. Plans 028 and 029 change the lines around it.
- Messages name logical ids, types and physical ids. They never print property values.
- Ultracite style: no `console.log`, early returns, `for...of`, no nested ternaries.

## Scope

**In scope**:

- `packages/aws/src/data-retention.ts` (create): `AwsRetainData`, `dataBearingTypes`,
  `isRetained`, the change filter, the message builders, the delete commands.
- `packages/aws/src/cloudformation-synthesis.ts`, `cloudformation-template.ts`, `deploy.ts`,
  `deploy-clients.ts`, `index.ts`, `local.ts`.
- `packages/aws/test/data-retention.test.ts` (create), `deploy.test.ts`, `local.test.ts`,
  `local-aws-emulator.test.ts`, `resources-only-synthesis.test.ts`, and the two fixtures in
  `packages/aws/test/fixtures/` named above.
- `packages/core/src/provider.ts`, `cli.ts`, `cli-spec.ts`; `packages/core/test/deploy-cli.test.ts`,
  `cli-contract.test.ts`, `fixtures/resources-cloudformation.json`, and any core test whose
  expected Provider Extension Record for a builder-made table, bucket or secret now needs
  `dataBearing: true`.
- Docs: `apps/docs/content/docs/guides/resources.mdx`, `guides/deploy.mdx`,
  `guides/troubleshooting.mdx`, `guides/local-aws.mdx` (one sentence),
  `guides/idempotency.mdx` (one sentence), `reference/cli.mdx`, `reference/config.mdx`,
  `getting-started.mdx` (line 88).
- `CONTEXT.md`, a new ADR in `docs/adr/`, `docs/stable-public-surface.md` if it lists `aws()`
  options or CLI flags.
- Example tests that compare a synthesized template, if `bun run test` shows one failing.

**Out of scope**:

- `packages/core/src/model.ts`, `config.ts` and `VokeResourceInput`.
- `packages/idempotency/**` (plan 032), `packages/core/src/serverless-migration.ts` (plan 025).
- Dead-letter queues and whether they are data-bearing (plan 028); per-Function IAM (plan 029).
- A `protect` setting that refuses `voke remove` for a stage (`roadmap-v2.md` phase 1).
- `voke remove --delete-data`, emptying buckets, a `voke import` command.
- Point-in-time recovery, bucket versioning, backups, `Snapshot` policies.
- The `voke-bootstrap` artifact bucket and Durable Function versions.
- Retaining log groups.

## Git workflow

- Branch `feature/data-resource-retention`, stacked on the previous plan's branch
  (`origin/main` stops at PR #52; this round is planned on `feature/docs-revamp`).
- Commit subjects are imperative sentences that state the outcome, for example
  "Keep tables, buckets and secrets when a deploy or a remove would delete them".
- Commit only if the task authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: Retention policies in the template

Tests first, in `packages/aws/test/data-retention.test.ts`:

- `synthesizeCloudFormation` with all eight builders: the table, the bucket and the secret have
  `DeletionPolicy: "Retain"`, `UpdateReplacePolicy: "Retain"` and `Metadata.VokeRetain: true`;
  the queue, stream, topic, event bus and parameter have none of the three.
- The same on stage `prod`, `dev` and `local` through `synthesizeCloudFormationFromModel`
  (the default does not depend on the stage).
- `{ retainData: false }` removes all three from every resource.
- A predicate receives `{ key: "usersTable", stage: "prod", type: "AWS::DynamoDB::Table" }`,
  is called only for marked resources, and its result decides per resource.
- A raw `VokeResourceInput` of type `AWS::DynamoDB::Table` (copy the shape from
  `packages/core/test/model.test.ts:240-265`) synthesizes to exactly
  `{ Metadata: { VokeBinding }, Properties, Type }`.
- `aws({ retainData: false }).synthesis.synthesize(...)` emits no policy; `aws()` does.
- Every builder whose record has `dataBearing: true` has its `cloudFormationType` in
  `dataBearingTypes`.

Then implement:

- `data-retention.ts`: `AwsRetainData`, `dataBearingTypes` (the three types), and
  `isRetained(retainData, resource)` (`undefined` means `true`).
- `cloudformation-template.ts`: `dataBearing?: boolean` on `AwsCloudFormationResourceProvider`.
- `cloudformation-synthesis.ts`: `dataBearing?: true` on the `awsCloudFormationResource`
  argument and on `StackResourceDefinition["provider"]["aws"]["properties"]`; set it in
  `dynamodbTable`, `s3Bucket` and `secret`. Add `retainData?: AwsRetainData` to
  `SynthesisOptions`. Target shape of the loop body:

  ```ts
  const retained =
    provider.dataBearing === true &&
    isRetained(options.retainData, {
      key: name,
      stage: model.service.stage,
      type: provider.cloudFormationType,
    });

  templateResources[logicalId] = {
    ...(retained
      ? { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" }
      : {}),
    Metadata: {
      VokeBinding: { Attribute: resource.binding.attribute, Resource: name },
      ...(retained ? { VokeRetain: true } : {}),
    },
    Properties: withDerivedVisibilityTimeout(model, name, resource),
    Type: provider.cloudFormationType,
  };
  ```

- `index.ts`: `retainData?: AwsRetainData` on `AwsProviderOptions` with a doc comment; pass it
  at `:320` (synth) and to `deployAwsStack` through `DeployDependencies.retainData`, which
  `deploy.ts:545` forwards to synthesis.
- `local.ts`: pass `retainData: false` at `:210` and `:429`. Add one assertion to
  `local.test.ts` (Floci) and one to `local-aws-emulator.test.ts` (AWS Emulator) that the
  bootstrap template of a project with a table has no `DeletionPolicy`.
- Update the three fixtures and `resources-only-synthesis.test.ts`. The fixture diff must hold
  only the two policies and `VokeRetain` on tables and buckets.

**Evidence**: `cd packages/aws && bun test` and
`cd packages/core && bun test test/cloudformation.test.ts` → 0 fail.

### Step 2: The change set carries what the pre-flight needs

Tests first (extend the fake in `deploy.test.ts`): `executeChangeSet` is called with
`{ retainExceptOnCreate: true }` for the app stack and for `voke-bootstrap`.

Then, in `deploy-clients.ts`:

- `ChangeSetChange`: add `physicalId?: string` (`ResourceChange.PhysicalResourceId`) and
  `policyAction?: string` (`ResourceChange.PolicyAction`); map both in `describeChangeSet`.
- `StackEvent`: add `physicalId?: string` (`PhysicalResourceId`).
- `executeChangeSet(id, options: { retainExceptOnCreate: boolean })`, sent as
  `RetainExceptOnCreate`. `deploy.ts` always passes `true`.

### Step 3: Pre-flight refusal and `--accept-data-loss`

Tests first.

`packages/aws/test/deploy.test.ts`, with `Scenario.changes` and an existing `shop-dev` stack:

- `Remove` of `UsersTable` (`AWS::DynamoDB::Table`, `policyAction: "Retain"`,
  `physicalId: "shop-dev-UsersTable-1ABC"`): rejects with `VokeDeployError`; the message has
  the first line, the "would leave the stack" sentence, the physical id and
  `--accept-data-loss`; `deleteChangeSet:shop-dev` was called and `executeChangeSet:shop-dev`
  was not.
- The same with `policyAction: "Delete"` and with no `policyAction`: "would be DELETED".
- `Modify` with `replacement: "True"` and `"Conditional"`, for `ReplaceAndRetain` and
  `ReplaceAndDelete`: the two "replaced" sentences.
- `Modify` with `replacement: "False"` on a table, and `Remove` of an `AWS::SQS::Queue`: the
  deploy runs.
- Two offending changes produce one error that lists both.
- With `acceptDataLoss: true`: the change set is executed, and for the kept ones the output
  has the kept block with the delete command and the region; a deleted one is not listed.
- Dry run: no rejection, each line is printed with the `Warning: ` prefix, nothing is executed.
- A Lambda replacement together with a data change still reports the Lambda message (existing
  behaviour first).

`packages/core/test/deploy-cli.test.ts`: `runCli(["deploy", …, "--accept-data-loss"])` reaches
the Provider with `acceptDataLoss: true`; without the flag it is `false`.
`cli-contract.test.ts`: `voke deploy --help` lists `--accept-data-loss`.

Then implement:

- `data-retention.ts`: `dataResourceChanges(changes)` (the filter of decision 7),
  `describeDataChange(change)`, `dataLossMessage(stackName, changes)`,
  `keptResourceLines(resources, region)`.
- `deploy.ts`: `StackDeployment.acceptDataLoss` (the bootstrap stack passes `false`) and the
  region; in `deployStack`, after `namedFunctionReplacements`: warn on a dry run; otherwise
  throw when there are data changes and the flag is off; after a successful
  `executeAndFollow`, print the kept block for the changes whose `policyAction` is `Retain` or
  `ReplaceAndRetain`.
- Core: `ProviderDeployInput.acceptDataLoss: boolean` with the comment "The user accepted
  changes that remove or replace resources holding data."; `deployProject({ acceptDataLoss })`;
  the `deploy` handler reads `isFlagSet(flags, "accept-data-loss")`; `cli-spec.ts` adds the
  flag (`boolean: true`, description "Apply changes that remove or replace a resource that
  holds data") and `[--accept-data-loss]` to the usage line. Update every place that builds a
  `ProviderDeployInput` (`grep -rn "artifactFiles:" packages examples`).

### Step 4: `voke remove` lists what it left behind

Tests first, in `deploy.test.ts`. Give the fake stack an `id`, and let the scenario add
`DELETE_SKIPPED` events (with `physicalId`) that `describeStackEvents` returns for the stack
name and for the stack id:

- A stack with a retained table and bucket: `removeAwsStack` resolves `{ status: "removed" }`
  and the output has the kept block with both physical ids and both delete commands.
- A `DELETE_SKIPPED` event of `AWS::Lambda::Version` is not listed.
- A `DELETE_SKIPPED` event that existed before the delete call (an earlier update's cleanup)
  is not listed.
- No skipped resource: no kept block.
- A stack description without `id`: the events gathered while following are used.
- The existing "bucket … is not empty" failure test still passes.

Then implement in `deploy.ts`: `removeAwsStack` keeps the description's `id`;
`deleteStackAndWait` returns the events that did not exist before the delete call; when an id
is known, read `describeStackEvents(id)` once more after the delete completes, because a
deleted stack can be read by id but not by name and the last events can arrive between two
polls. Filter to `DELETE_SKIPPED` and `dataBearingTypes`, then print `keptResourceLines`.
`removeProject` in core is unchanged; `Removed <name>-<stage>` stays the last line.

### Step 5: Docs, vocabulary and ADR

- `guides/resources.mdx`: a "Data retention" section after "Builders": which builders are
  data-bearing and why the others are not; what Voke emits; `retainData` with the predicate
  sample (` ```ts twoslash `, it must compile); the resource key and a table's `partitionKey`
  and `sortKey` identify the resource, and changing them means a new, empty resource; raw
  definitions are untouched; a stack deployed before this version protects a resource only
  after one deploy that keeps it.
- `guides/deploy.mdx`: a section "Changes that remove or replace data" with the refusal text,
  what `--accept-data-loss` does and that it does not belong in a CI script; rewrite "Remove a
  stage" with the kept block, the note that kept resources are billed, and the three paths of
  decision 11. For the import path, link AWS's "Import AWS resources into a CloudFormation
  stack" page (check that the URL resolves) and state its limits: the stack's template must
  gain the resource in an import-only change set first, then `voke deploy`. Add "to delete a
  stage's data with its stack: `retainData`, deploy, remove".
- `guides/troubleshooting.mdx`: an entry "A deploy would remove or replace data", in the form
  of "A Function must be replaced" (message, cause, fix).
- `reference/cli.mdx`: the new usage line and flag for `deploy` (copy the real `--help`
  output), one sentence in its description, and the `remove` paragraph.
- `reference/config.mdx`: "`aws()` … takes three options", a `retainData` row, and a row in
  "Defaults".
- `getting-started.mdx:88`, `guides/local-aws.mdx`, `guides/idempotency.mdx`: one sentence
  each (remove keeps data-bearing resources; local resources are never retained; the
  idempotency table is retained by default).
- `CONTEXT.md`: **Data-Bearing Resource** ("A resource whose stored state exists nowhere else
  and cannot be recreated by a redeploy: a table, a bucket or a generated secret." _Avoid_:
  stateful resource, persistent resource) and **Retained Resource** ("A Data-Bearing Resource
  that a deploy or a remove left in the account, outside any stack." _Avoid_: orphan, leftover).
  Add relationships: retained by default on every stage; `aws({ retainData })` is the one
  opt-out; raw resource definitions are never retained by Voke.
- ADR, next free number at execution time (`0018` at planning time; three files share `0007`):
  decisions 1–3, 5–8 and 10, the `--stage` reason for a Provider-level predicate, and the
  trade-off (orphans that are billed until deleted, in exchange for no silent data loss).

**Evidence**: `cd apps/docs && bun run check:samples guides/resources.mdx && bun run test && bun run lint:links` → exit 0.

## Test plan

- New: `packages/aws/test/data-retention.test.ts` (Step 1 cases).
- Extended: `packages/aws/test/deploy.test.ts` (Steps 2–4), `local.test.ts`,
  `local-aws-emulator.test.ts`, `resources-only-synthesis.test.ts`,
  `packages/core/test/deploy-cli.test.ts`, `cli-contract.test.ts`; three fixtures.
- Pattern: the two tests at the end of `deploy.test.ts` ("a change set that replaces a named
  Lambda fails before executing…", "a dry run warns…") are the model for the pre-flight cases.
- No test sleeps or calls AWS; `sleep` is injected as in the existing tests.
- Verification: `bun run test` → 0 fail.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] `voke synth` for `examples/hello-api`
      (`cd examples/hello-api && bun ../../packages/core/src/cli.ts synth --stage dev --out <tmp>/t.json`)
      shows `DeletionPolicy` and `UpdateReplacePolicy` `Retain` on `UsersTable` and neither on
      `EventsQueue`
- [ ] A change set that removes or replaces a table, bucket or secret is refused without
      `--accept-data-loss`, and the change set is deleted (tests of Step 3)
- [ ] `voke remove` prints each retained resource with its physical id and delete command
      (tests of Step 4)
- [ ] The bootstrap templates of both Local AWS Providers contain no `DeletionPolicy`
- [ ] `git diff --stat <base> -- packages/core/src` lists only `provider.ts`, `cli.ts` and
      `cli-spec.ts`; `git diff --stat <base> -- packages/idempotency` is empty
- [ ] `grep -rn "TableName\|BucketName" packages/aws/src/cloudformation-synthesis.ts` returns
      no matches
- [ ] The ADR exists; `CONTEXT.md` defines **Data-Bearing Resource**
- [ ] The report lists the four real-AWS checks below as run or not run

Real-AWS checks (the executor has no credentials; report them as not run unless the owner
runs them): a deploy that only adds the policies to an existing stack is applied;
`PolicyAction` is present on a `Remove` change; `voke remove` lists a retained table through
`DELETE_SKIPPED`; a failed first deploy leaves no table behind.

## STOP conditions

- The work needs a core change outside `provider.ts`, `cli.ts` and `cli-spec.ts`, or a new
  field on `VokeResourceInput` or the model. Decision 4 says the marker is AWS-only; report
  why it cannot be.
- A builder is found to set a physical name, or a prerequisite plan added one. `Retain` on a
  named resource blocks the next create; the default needs a new decision.
- Plan 026 changed how the `deploy` handler reads flags so that a boolean flag can no longer
  be declared in `cli-spec.ts`. Report the new mechanism before adding the flag another way.
- The Floci deploy path used by `examples/e2e` rejects `RetainExceptOnCreate` or the policy
  attributes (visible only with Docker). Report the emulator's error; do not drop decision 9.

## Maintenance notes

- Plan 028: decide whether a dead-letter queue is data-bearing by setting `dataBearing` on its
  definition and adding its type to `dataBearingTypes`; note that the pre-flight then refuses
  every removal of an Event Source Function that owns one.
- Plan 029 rewrites how resource statements reach roles in the same loop; this plan's edit is
  the resource literal only.
- Plan 025: a migrated `AWS::DynamoDB::Table` becomes `dynamodbTable()`, which is now retained
  even when the Serverless service deleted it. The migration report may want to say so.
- A future builder option that sets a physical name must turn retention off for that resource
  or refuse the combination.
- The kept block depends on `DELETE_SKIPPED` events and on `PolicyAction`. If an emulator or a
  partition omits them, the fallback is the worst-case wording ("DELETED") and no kept block.
- Reviewers should check: the fixture diffs contain only policies and `VokeRetain`; no core
  name mentions AWS; the refusal deletes the change set; no message prints property values.
- Deferred: `protect` for a stage, `voke remove --delete-data`, a `voke import` command, a
  builder-level override, retention for the artifact bucket, pruning retained Durable Function
  versions.
