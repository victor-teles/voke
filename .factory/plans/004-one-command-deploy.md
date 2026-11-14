# Plan 004: `voke deploy` takes a project from source to a live URL in one command, through the configured Provider

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 3435023 -- packages/core/src packages/core/test packages/core/package.json packages/aws packages/build/src README.md apps/docs/content docs/e2e-testing.md examples`
> and `git status --short` with the recorded current state below. Plans 009, 003 and 008 are
> expected to land first and will change many of these files (see "State expected after
> prerequisites"). Reconcile routine drift. Pause dependent work if drift invalidates scope, a
> protected contract, or an unresolved product or permission decision.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `.factory/plans/009-*.md` (finish the `@voke/aws` split, including Runtime Variable IAM parity), `.factory/plans/003-registry-discovery-and-lambda-entries.md` (CLI build through the Provider `build.plan`, the build manifest, and `provider` set in `voke.config.ts`), `.factory/plans/008-one-spelling-per-setting.md` (recommended order only; both edit `packages/aws/src/cloudformation-synthesis.ts`)
- **Category**: direction
- **Planned at**: commit `3435023`, 2026-11-14

## Why this matters

Voke has no working path to AWS. Every synthesized Lambda contains a placeholder that answers 501. The only deploy command is `voke experimental deploy`, which shells out to the AWS CLI, uploads no code
and is not routed through the configured Provider. The README documents top-level
`voke deploy`/`voke remove` commands that the CLI rejects. "Easy to deploy" is the product goal.
After this plan, `voke deploy --stage dev` builds, packages, uploads, deploys through
CloudFormation, shows progress and prints the API URL, with no AWS CLI installed. `voke remove`
tears the stage down safely. Deploy is a Provider Capability, so core stays provider-neutral, as
ADR `docs/adr/0007-specialized-provider-and-helper-packages.md` requires.

## Current state (at 3435023)

### Architecture constraints (binding)

- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`:
  > The core package owns provider-neutral Function, Gateway, config, contract, route, and Provider
  > capability contracts; `@voke/aws` depends on public `voke` and owns the full AWS workflow, including
  > AWS runtime adapters, resource helpers, SQS and authorizer entrypoints, local AWS workflow helpers,
  > and CloudFormation synthesis under `@voke/aws/cloudformation`. [...] This keeps future providers
  > possible without making root `voke` depend on AWS, CloudFormation, SQS, or API Gateway concepts.
- Core source must not import `@voke/*` at runtime. `@voke/aws` depends on `voke`, so the reverse
  would be a workspace cycle that turbo rejects. `packages/core/tsconfig.json` maps `@voke/*` to
  sibling sources **for tests only**. AWS behaviour reaches the core CLI only through
  `config.provider`.
- `CONTEXT.md` terms to use in names, comments and docs: **Provider**, **Provider Capability**,
  **AWS Provider**, **Provider Extension Record**, **Runtime Variable**.
- User decision U2: the Provider is set only in `voke.config.ts` (`provider: aws()`). Plan 003
  makes that true for examples and the Gateway.

### Provider contract: `packages/core/src/provider.ts` (whole file, 60 lines)

`VokeProvider { build?, invoke?, local?, name, runtime?, synthesis?, validate? }`. There is no
deploy capability. `ProviderSynthesisCapability.synthesize` takes `{ config, model }` and returns
`TArtifact`. `packages/core/src/index.ts:46-55` exports these types. The AWS implementation is
`aws()` in `packages/aws/src/index.ts:97-132`: it provides `local.devEnvironment`,
`runtime.gateway`, `synthesis.synthesize` (→ `synthesizeCloudFormationFromModel(model)`) and
`validate`.

### CLI: `packages/core/src/cli.ts`

- `:57-74` `printHelp` lists `Experimental: voke experimental deploy|remove`. `:76-84` `commandName`
  special-cases `experimental`. `:88-100` `commandUsage` has an `experimental` entry.
- `:131-168` `parseFlags`: every `--flag` needs a value (`:154` throws `Missing value for --${key}`).
  Boolean flags such as `--yes` are impossible.
- `:170` `stackName = (name, stage) => \`${name}-${stage}\``.
- `:419-435` `loadConfigFromFlags`.
- `:470-485` `remove()` runs `aws cloudformation delete-stack` through the injected `run`. `:487-507`
  `deploy()` runs `aws cloudformation deploy --template-file ... --capabilities CAPABILITY_IAM`.
- `:509-546` `synth()`: the pattern to copy for provider routing:
  ```ts
  const synthesize = config.provider?.synthesis?.synthesize;
  if (synthesize === undefined) {
    throw new CliUsageError(
      config.provider === undefined
        ? "No provider configured for synthesis."
        : `Provider "${config.provider.name}" does not support synthesis.`
    );
  }
  ```
- `:548-567` `build()` runs core `createBuildPlan` (`packages/core/src/build.ts`). Plan 003
  reroutes it through `config.provider.build.plan`.
- `:672-703` the `experimental` subcommand, and `:757-759` its handler entry.
- `:802-806` in `runCli`: top-level `deploy`/`remove` throw
  `Deployment commands are experimental. Use: voke experimental ${command}`.
- `CliOptions` (`:20-24`) injects `output`, `run` and `showDetails`, so tests capture output.

### Synthesis (the live path is `@voke/aws`)

`packages/aws/src/cloudformation-synthesis.ts`:

- `:690-692` `synthesizeCloudFormationFromModel(model: VokeModel): CloudFormationTemplate`. The
  wrapper is `synthesizeCloudFormation(options)` at `:851-854`, exported from
  `@voke/aws/cloudformation`.
- `:617-624` the API stage: `StageName: model.service.stage`.
- `:667-672` the `ApiUrl` output: ``"Fn::Sub": `https://\${Api}.execute-api.\${AWS::Region}.amazonaws.com/${model.service.stage}` ``.
- `:793-796` the placeholder code in every Function:
  ```ts
  Code: {
    ZipFile:
      "export const handler = async () => ({ statusCode: 501, body: 'Build and upload this Voke function before deploying.' });",
  },
  ```
  Inline `ZipFile` code is saved as `index.js` and loaded as CommonJS, so `export const` fails with
  `Runtime.UserCodeSyntaxError: Unexpected token 'export'` (observed on AWS Emulator 1.0.367).
- A named stage breaks routing. With HTTP API payload v2, `rawPath` carries the stage prefix
  (`/dev/health`). The Gateway matches on `rawPath`, so a named stage would make every route return 404.
- `packages/core/src/cloudformation.ts` is a diverged legacy copy that plan 009 deletes. **Do not
  edit it.**

### AWS helpers in `@voke/aws`

- `packages/aws/src/resources.ts:67` `createAwsClientConfig({ endpoint?, region? })` reads
  `VOKE_AWS_ENDPOINT_URL`/`AWS_ENDPOINT_URL` and `AWS_REGION`/`AWS_DEFAULT_REGION` (default
  `us-east-1`).
- Narrow-client test seam to copy: `packages/aws/src/lambda-invoke-transport.ts` (an
  `AwsLambdaInvokeClient` interface plus SDK default).
- `packages/aws/package.json` dependencies: `@aws-sdk/client-lambda`, `@voke/http`, `hono`, `voke`.
  There is no CloudFormation or S3 client.
- `packages/aws/src/local-provider.ts:109-126` (Floci `voke local bootstrap`) shells out to
  `aws cloudformation deploy`. Plan 010 owns it, so leave it unchanged.

### Errors: `packages/core/src/errors/`

- `base.ts`: `class VokeError extends Error { code: VokeErrorCode; issues: VokeIssue[] }`.
- `shared.ts:1-6`: `VokeErrorCode = "CLI_USAGE_ERROR" | "CONFIG_ERROR" | "MODEL_ERROR" |
"RESOURCE_BINDING_ERROR" | "RUNTIME_VARIABLE_ERROR"`.
- `config.ts`: the exemplar subclass (`VokeConfigError`, which fixes `code`).
- `packages/core/src/errors.ts` re-exports all of them. The public `voke` index
  (`packages/core/src/index.ts:36`) exports only `VokeConfigError`, **not** `VokeError`.
- Conventions: `docs/error-conventions.md` (say what failed, which resource, and the next step).

### Config, stage and naming

- `packages/core/src/config.ts:230`: stage = `input.stage ?? VOKE_STAGE ?? STAGE ?? "local"`.
  `examples/hello-api/voke.config.ts` hardcodes `stage: "local"`, so a plain deploy would create
  a real stack named `hello-api-local`.
- `packages/core/src/config.ts:130,158`: `build.external` defaults to `["@aws-sdk/*"]`. The
  runtime bundle never contains AWS SDK code, and the Lambda Node.js runtime provides it.
- `packages/core/src/config.ts:177`: `cloudFormation.out` defaults to `./dist/cloudformation.json`,
  which is inside the default build outdir `./dist` (`:159`).

### Build output (post plan 002, at 3435023)

`voke build` runs `bun build <entrypoints> --outdir <outdir> --target node --format esm
--external @aws-sdk/*` and writes `<outdir>/package.json` (`{"type":"module"}`). The plan shape is
`BuildPlan { command, entrypoints, files, outdir, outputs }` (`packages/core/src/build.ts`, and a
copy in `packages/build/src/index.ts`).

### Tests and docs that reference the old behaviour

- `packages/core/test/api.test.ts:645-690` and `:843-...` assert `experimental deploy/remove`
  through the `run` seam. `packages/core/test/cli-contract.test.ts` covers CLI routing.
- Stage-suffixed URL expectations: `packages/core/test/e2e.test.ts:232,249`,
  `packages/core/test/api.test.ts:795`, `packages/core/test/fixtures/*-cloudformation.json`,
  `examples/e2e/test/local-floci.e2e.test.ts:19,38`. Some of these test core's legacy copy, which
  009 deletes or moves. Update whichever still exist and exercise `@voke/aws` synthesis.
- `README.md:86-87` shows `voke deploy --name hello-api --stage local --template ...` and
  `voke remove ...`. `apps/docs/content/docs/reference/cli.mdx:38-45` ("Deploy and remove") is the
  same. `apps/docs/content/docs/meta.json` lists the guides. `docs/e2e-testing.md` describes
  smoke tests against a deployed `ApiUrl`.

### State expected after prerequisites (verify before Step 1; see STOP conditions)

- **009 done**: core has no AWS synthesis or SDK code to edit. `@voke/aws` synthesis emits
  per-Function Runtime Variable IAM (Secrets Manager/SSM). Runtime Variable `secret`/`parameter`
  come from `@voke/aws`, and CloudFormation builders from `@voke/aws/cloudformation`.
- **003 done**: `voke build` calls `config.provider.build.plan` (implemented by `@voke/aws` on a
  provider-neutral base plan). The outdir contains the generated Lambda entry (`index.js`
  exporting one handler per registry key), `package.json` and a build manifest
  (`voke-manifest.json`). A project loader (`loadProject` or equivalent) gives the config with the
  discovered Function Registry. Examples set `provider: aws()` in `voke.config.ts`. Deployed
  Function names are `${name}-${stage}-${key}`.
- **008 done**: duplicate spellings removed. Re-read the line numbers in
  `cloudformation-synthesis.ts`.

## Decisions taken in this plan (user-approved 2026-11-14; reversible)

1. **Deploy is a Provider Capability.** `ProviderDeployCapability { deploy, remove }` is added to
   core's Provider contract with provider-neutral types only. The CLI keeps stage resolution,
   the `local`-stage guard, the build step, output printing and the outputs file. All AWS SDK,
   CloudFormation, S3 and zip code lives in `@voke/aws`.
2. **AWS SDK, not the AWS CLI.** `@aws-sdk/client-cloudformation` and `@aws-sdk/client-s3` are
   added to `packages/aws/package.json` (not core), loaded with dynamic `import()` so other
   commands start fast. `build.external` keeps them out of runtime bundles.
3. **Neutral `VokeDeployError` in core**, and `VokeError` is exported publicly, so providers
   throw a typed, provider-neutral error.
4. **The artifact reference stays internal to `@voke/aws`.** `ProviderSynthesisCapability` is not
   widened. The AWS deploy capability calls `synthesizeCloudFormationFromModel(model, { artifact })`
   itself.
5. **`$default` API stage.** One stack per Voke stage already isolates environments, so the HTTP
   API uses `$default` and the URL has no stage suffix. This removes the `rawPath` prefix problem.
6. **`local` is reserved for the emulator.** `voke deploy` refuses stage `local` unless a custom
   AWS endpoint is configured.
7. **One content-addressed artifact per deploy**, shared by all Functions in the stack.
8. **ADR number**: three ADRs share `0007`. Use the next free ADR number at execution time. Do not
   assume `0008` is free.

## Commands you will need

| Purpose                         | Command                                                                                    | Expected on success                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Install                         | `bun install`                                                                              | exit 0                                                                                  |
| Add AWS deps                    | `cd packages/aws && bun add @aws-sdk/client-cloudformation @aws-sdk/client-s3`             | exit 0, `bun.lock` updated                                                              |
| Core tests                      | `cd packages/core && bun test`                                                             | 0 fail                                                                                  |
| AWS tests                       | `cd packages/aws && bun test`                                                              | 0 fail                                                                                  |
| One file                        | `cd packages/aws && bun test test/deploy.test.ts`                                          | 0 fail                                                                                  |
| Package typecheck               | `cd packages/<core\|aws> && bun run typecheck`                                             | exit 0                                                                                  |
| Repo gates                      | `bun run typecheck && bun run test`                                                        | exit 0 (turbo runs every workspace)                                                     |
| Lint/format check               | `bun run check`                                                                            | exit 0                                                                                  |
| Dry run (needs AWS credentials) | `cd examples/hello-api && bun ../../packages/core/src/cli.ts deploy --stage dev --dry-run` | prints the change set; executes nothing. Run only with operator authorization (Step 8). |

## Implementation rules relevant to this plan

- Test first. All AWS interaction goes through a narrow injected interface (`DeployAwsClients`),
  so unit tests use fakes. No test may call real AWS or the network.
- **Do not deploy to a real AWS account, create buckets or delete stacks unless the operator
  explicitly authorizes it and provides credentials.**
- Never print or log credential values. Messages may name the credential source type (profile,
  environment, SSO), never contents.
- Boundaries:
  - `packages/core/src/**` must not import `@voke/*` or `@aws-sdk/*` for deploy.
  - New core types in `provider.ts` must not mention CloudFormation, S3, stacks, buckets or
    regions as AWS concepts. Use neutral words: `stage`, `outputs`, `artifact directory`,
    `region` as an optional opaque string.
  - `packages/aws/src/**` may use the AWS SDK only through dynamic `import()` in the default
    client factory.
- CLI-time modules may use Bun APIs. Runtime modules (anything bundled into a Lambda) must not
  (plan 002).
- Errors:
  - `CliUsageError` (`cli.ts:49-54`) for bad invocations.
  - `VokeDeployError` (code `DEPLOY_ERROR`) for provider and stack failures.
  - Messages say what failed, which resource, and the next step.
- `voke synth` must stay deterministic and offline. Without an artifact, synthesis still emits the
  placeholder `ZipFile`.
- Use `node:path` and `node:fs/promises` in new code: no `split("/")`, no `mkdir -p` through the
  shell.
- Do not edit `packages/core/src/cloudformation.ts`, `aws.ts`, `local.ts` or `local-provider.ts`.
  If they still exist, 009/010 own them.

## Scope

**In scope**:

- Core (provider-neutral):
  - `packages/core/src/provider.ts`: add `ProviderDeployCapability` and the `deploy` field.
  - `packages/core/src/index.ts`: export the new types, `VokeError` and `VokeDeployError`.
  - `packages/core/src/errors/deploy.ts` (create), `packages/core/src/errors/shared.ts` (add
    `DEPLOY_ERROR`), `packages/core/src/errors.ts`.
  - `packages/core/src/cli.ts`: boolean flags, `deploy`/`remove` commands, help and usage text,
    deleting the `experimental` group and the AWS-CLI `deploy`/`remove` functions.
  - `packages/core/src/deploy-outputs.ts` (create, optional): writes `.voke/outputs/<stage>.json`.
- AWS:
  - `packages/aws/src/deploy.ts`, `packages/aws/src/deploy-clients.ts`, `packages/aws/src/zip.ts`
    (create).
  - `packages/aws/src/index.ts`: wire `aws().deploy`.
  - `packages/aws/src/cloudformation-synthesis.ts`: artifact `Code`, `$default` stage, `ApiUrl`,
    placeholder fix.
  - `packages/aws/package.json`, `bun.lock`.
- Tests:
  - `packages/aws/test/deploy.test.ts`, `packages/aws/test/zip.test.ts` (create), and the
    synthesis tests in `packages/aws/test/` (create or extend).
  - `packages/core/test/cli-contract.test.ts`, `packages/core/test/api.test.ts`,
    `packages/core/test/e2e.test.ts`, `packages/core/test/public-surface.test.ts` and
    `packages/core/test/fixtures/*-cloudformation.json` (only the URL and stage shape, and only
    where they still exist after 009), `packages/core/test/error-design.test.ts` if it
    enumerates error codes.
  - `examples/e2e/test/*.e2e.test.ts` (URL shape only).
- Examples: `package.json` scripts (`deploy`, `remove`).
- Docs:
  - `README.md`, `apps/docs/content/docs/reference/cli.mdx`,
    `apps/docs/content/docs/getting-started.mdx`.
  - `apps/docs/content/docs/guides/deploy.mdx` (create), `apps/docs/content/docs/meta.json`.
  - `docs/e2e-testing.md`.
  - `docs/adr/<next-free-number>-deploy-provider-capability.md` (create).
- `.factory/plans/README.md` (status only, and only if the coordinator does not own it).

**Out of scope**:

- `voke local *`, the Floci and AWS Emulator providers, and `ProviderLocalCapability` (plans 010
  and 007).
- Removing core's legacy AWS copies or core's `@aws-sdk/*` dependencies (plan 009).
- Provider `build.plan`, the Lambda entry and the manifest format (plan 003). Consume them; do not
  change them.
- Custom domains, per-Function bundles, single-Function deploy, preview stages, CI workflow
  generation, removal policies and stage protection (roadmap v2). `remove` gets only an
  interactive confirmation.
- Lambda memory, timeout, architecture and log defaults (plan 005).

## Git workflow

- Branch: `feature/one-command-deploy`
- Commit only if authorized by the task. Use short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Confirm prerequisites

Verify the "State expected after prerequisites" list:

- `grep -rn "@aws-sdk" packages/core/src` lists no CloudFormation or synthesis code.
- `grep -n "provider" examples/hello-api/voke.config.ts` shows `provider: aws()`.
- `bun run build` (or `voke build` in `examples/hello-api`) produces the Lambda entry,
  `package.json` and the manifest in the outdir.
- `@voke/aws` synthesis emits Runtime Variable IAM.

Record the actual build output file names. Steps 5 and 6 use them.

### Step 1: Neutral deploy contract and error in core

`packages/core/src/provider.ts`:

```ts
export interface ProviderDeployInput {
  config: VokeConfig;
  model: VokeModel;
  /** Build output directory produced by the provider build plan. */
  artifactDirectory: string;
  /** Files in artifactDirectory that belong to the deployable artifact (from the build plan). */
  artifactFiles: readonly string[];
  stage: string;
  region?: string;
  dryRun: boolean;
  output: (line: string) => void;
}

export interface ProviderDeployResult {
  /** Stack or deployment identifier, for display and the outputs file. */
  id: string;
  region?: string;
  status: "deployed" | "unchanged" | "dry-run";
  /** Provider outputs; "ApiUrl" is printed first when present. */
  outputs: Record<string, string>;
}

export interface ProviderRemoveInput {
  config: VokeConfig;
  stage: string;
  region?: string;
  output: (line: string) => void;
}

export interface ProviderDeployCapability {
  deploy?: (input: ProviderDeployInput) => Promise<ProviderDeployResult>;
  remove?: (
    input: ProviderRemoveInput
  ) => Promise<{ status: "removed" | "absent" }>;
}
```

Then:

- Add `deploy?: ProviderDeployCapability` to `VokeProvider`, and add `ProviderDeployCapability`
  to the `VokeProviderCapability` union.
- Create `packages/core/src/errors/deploy.ts`, modelled on `errors/config.ts`:
  `class VokeDeployError extends VokeError` with code `"DEPLOY_ERROR"`.
- Add `"DEPLOY_ERROR"` to `VokeErrorCode` (`errors/shared.ts:1-6`) and re-export from `errors.ts`.
- Export `VokeError`, `VokeDeployError` and the new types from `packages/core/src/index.ts`.
- Update `public-surface.test.ts` and any export-list assertion.

Confirmation is the CLI's job: `remove` is called only after confirmation, so the contract needs
no `confirm` field.

**Evidence**: `cd packages/core && bun run typecheck && bun test test/public-surface.test.ts` → pass.

### Step 2: Boolean flags in the CLI parser

Extend `parseFlags` (`cli.ts:131-168`) with a set of boolean flag names: `yes`, `dry-run`,
`verbose`, `help`, `force`. They take no value and are stored as `"true"`; `--flag=false` is
allowed. Every other flag keeps today's behaviour, including `Missing value for --key`. Test in
`packages/core/test/cli-contract.test.ts`.

### Step 3: Deterministic zip writer in `@voke/aws`

`packages/aws/src/zip.ts`:

```ts
export interface ZipEntry { path: string; data: Uint8Array; }
export const createZip = (entries: readonly ZipEntry[]): Uint8Array;
```

Requirements:

- DEFLATE via `node:zlib` `deflateRawSync`, plus CRC-32.
- Entries sorted by path, with a fixed timestamp, so identical input gives identical bytes.
- Forward-slash paths.
- "Version made by" = Unix, with mode `0o644` in the external attributes (Lambda rejects
  unreadable files).
- No new dependency.
- Throw `VokeDeployError` if an entry or the archive would exceed classic (non-ZIP64) limits.

Keep it internal (not exported from the `@voke/aws` index).

### Step 4: AWS client seam

`packages/aws/src/deploy-clients.ts`. Model it on `packages/aws/src/lambda-invoke-transport.ts`.

```ts
export interface DeployAwsClients {
  describeStack(name: string): Promise<StackDescription | undefined>;
  createChangeSet(input: ChangeSetInput): Promise<{ id: string }>;
  describeChangeSet(id: string): Promise<ChangeSetDescription>;
  executeChangeSet(id: string): Promise<void>;
  deleteChangeSet(id: string): Promise<void>;
  describeStackEvents(
    name: string,
    sinceEventId?: string
  ): Promise<StackEvent[]>;
  deleteStack(name: string): Promise<void>;
  objectExists(bucket: string, key: string): Promise<boolean>;
  putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    contentType: string
  ): Promise<void>;
}
export const createDeployAwsClients = async (options: {
  region?: string;
  endpoint?: string;
}) => DeployAwsClients;
```

- The default implementation dynamically imports `@aws-sdk/client-cloudformation` and
  `@aws-sdk/client-s3`.
- Region and endpoint come from `createAwsClientConfig` (`packages/aws/src/resources.ts:67`), so
  `AWS_ENDPOINT_URL` keeps working for emulators.
- Map SDK credential errors (`CredentialsProviderError`, `ExpiredToken`, `UnrecognizedClient`,
  and similar) to `VokeDeployError` with this message:
  `AWS credentials were not found or have expired. Configure a profile (AWS_PROFILE), run your SSO login, or set environment credentials, then retry.`

Add both SDK packages to `packages/aws/package.json` `dependencies`. Do not add them to core.

### Step 5: Synthesis accepts an artifact and uses the `$default` stage

In `packages/aws/src/cloudformation-synthesis.ts`. Re-locate the lines after 008: they are near
`:617-624`, `:667-672` and `:793-796` at 3435023.

- `synthesizeCloudFormationFromModel(model, options?: { artifact?: { bucket: string; key: string } })`.
  - With `artifact`, every Function built from the shared bundle gets
    `Code: { S3Bucket, S3Key }`.
  - Without it, the placeholder stays.
  - The `synthesis.synthesize` capability keeps calling it without options.
- Placeholder: `exports.handler = async () => ({ statusCode: 501, body: "Build and upload this Voke function before deploying." });`
- `Stage`: `StageName: "$default"`. `ApiUrl`: `https://${Api}.execute-api.${AWS::Region}.amazonaws.com`
  (no suffix).
- Update every still-existing expectation of `amazonaws.com/<stage>` (see Current state) and any
  `StageName` assertion.

### Step 6: AWS deploy and remove pipeline

`packages/aws/src/deploy.ts`:

- `deployAwsStack(input: ProviderDeployInput, deps: { clients: DeployAwsClients; now?: () => number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> })`
- `removeAwsStack(input: ProviderRemoveInput, deps)`

Wire them in `aws()` as
`deploy: { deploy: (input) => deployAwsStack(input, { clients: await createDeployAwsClients(...) }), remove: ... }`.

`deployAwsStack`:

1. **Names**: stack `<config.name>-<stage>`. Region = `input.region ?? config.region ?? createAwsClientConfig().region`.
2. **Package**: zip `input.artifactFiles` (relative to `artifactDirectory`). Never include
   `cloudformation.json` or `*.zip`, even if listed. Key:
   `<name>/<stage>/<first 16 hex of sha256(zip)>.zip`. Print the bundle size.
3. **Bootstrap**: ensure stack `voke-bootstrap` exists in the region, with one private,
   encrypted S3 bucket (`PublicAccessBlockConfiguration` all true, `BucketEncryption` AES256) and
   output `ArtifactBucketName`. Create it through the same change-set path if absent.
4. **Upload** the zip unless `objectExists`. Synthesize with
   `synthesizeCloudFormationFromModel(input.model, { artifact })`, upload the template to
   `<name>/<stage>/template-<hash>.json`, and deploy with `TemplateURL` (inline templates are
   limited to 51,200 bytes).
5. **Change set**: type `CREATE` when the stack is absent, `UPDATE` otherwise. Capabilities
   `CAPABILITY_IAM`; use `CAPABILITY_NAMED_IAM` only if 009's per-Function roles set `RoleName`.
   Stack states:
   - `ROLLBACK_COMPLETE`: delete the failed stack, then create.
   - Any `*_IN_PROGRESS`: `VokeDeployError` "A deployment is already in progress for <stack>".
   - `UPDATE_ROLLBACK_FAILED`: `VokeDeployError` naming the console action to take.
   - Empty change set ("didn't contain changes"): delete it and return `status: "unchanged"`
     with the current outputs.
6. **`dryRun`**: describe the change set, print each change (`Add | Modify | Remove`, logical id,
   resource type), delete it, and return `status: "dry-run"`. The artifact and template are still
   uploaded because the change set references them. Nothing is executed.
7. **Execute and follow**: poll `describeStackEvents` (injectable interval, default 2 s) and print
   one line per resource status change. On failure, throw `VokeDeployError` with the first
   `*_FAILED` event's logical id and reason.
8. Return `{ id: stack, region, status: "deployed", outputs }`.

`removeAwsStack`:

- A missing stack returns `{ status: "absent" }`.
- Otherwise `deleteStack`, follow events until `DELETE_COMPLETE`, and report resources that
  failed to delete (for example a non-empty bucket) with the reason, as `VokeDeployError`.

### Step 7: CLI wiring (core)

- `voke deploy [--stage <stage>] [--region <region>] [--config <path>] [--dry-run] [--verbose]`.
  The order is:
  1. Load config with `loadConfigFromFlags`, and the project with the 003 project loader.
  2. Resolve stage: `--stage` → `VOKE_STAGE` → config.
  3. If the stage is `local` and no `AWS_ENDPOINT_URL`/`VOKE_AWS_ENDPOINT_URL` is set, throw
     `CliUsageError`:
     `Stage "local" is reserved for the local emulator. Deploy to AWS with: voke deploy --stage dev`.
  4. Require `config.provider?.deploy?.deploy`, with the same two-branch message pattern as
     `synth` (`cli.ts:524-531`), worded for deploy.
  5. Run `build` (the 003 provider build path). Fail if a build-plan output file is missing.
  6. Call the provider with `artifactFiles` from the build plan's `outputs` and `files`.
  7. Print the outputs, `ApiUrl` first.
  8. Unless `status === "dry-run"`, write `.voke/outputs/<stage>.json` as
     `{ id, region, stage, outputs }`, using `node:fs/promises`.
- `voke remove [--stage <stage>] [--region <region>] [--config <path>] [--yes]`:
  - When stdin is a TTY, require typing `<name>-<stage>`.
  - `--yes` skips the confirmation.
  - Non-TTY without `--yes` throws `CliUsageError`.
  - The confirmation reader is injectable through `CliOptions`.
  - Then call `provider.deploy.remove`, and print `Nothing to remove` for `absent`.
- Delete the `experimental` command group:
  - delete `cli.ts:672-703`, `:757-759`, the `:802-806` rejection, the `experimental` special case
    in `commandName`, the `commandUsage.experimental` entry, the help section and the
    AWS-CLI-based `deploy`/`remove` functions (`:470-507`)
  - add `deploy`/`remove` to `printHelp` and `commandUsage`
  - `voke experimental ...` becomes an unknown command. Per ADR
    `docs/adr/0007-opinionated-framework.md`, removals happen without aliases while the package is
    unreleased.
- Output goes through `options.output ?? console.log`. Example:

  ```
  Building hello-api (dev)            index.js 109 KB
  Uploading artifact                  done
  Deploying stack hello-api-dev
    CREATE_COMPLETE  AWS::Lambda::Function      Function
    CREATE_COMPLETE  AWS::ApiGatewayV2::Api     Api
  Deployed in 48s

  ApiUrl  https://abc123.execute-api.us-east-1.amazonaws.com
  ```

### Step 8: Docs, ADR and example scripts

- `docs/adr/<next-free>-deploy-provider-capability.md`: context, decisions 1–7, consequences.
  Match the format of `docs/adr/0006-http-api-authorizers.md`.
- `apps/docs/content/docs/guides/deploy.mdx` (new; add `guides/deploy` to `meta.json`). Cover:
  - credentials and `provider: aws()` in `voke.config.ts`
  - `voke deploy --stage dev`
  - what gets created: the `voke-bootstrap` stack and bucket, and the app stack
  - `--dry-run`, the outputs file, `voke remove`, and the reserved `local` stage
  - the minimal IAM actions for the deploying identity: CloudFormation, S3 on the artifact bucket,
    IAM role create/pass, Lambda, API Gateway, and services for declared resources and Runtime
    Variables
- `README.md` (`:86-87` and the CLI list), `reference/cli.mdx` ("Deploy and remove",
  `:38-45`) and `getting-started.mdx`: use the real commands, remove `--name`/`--template`, and
  add the deploy step to getting started.
- `docs/e2e-testing.md`: the URL shape, and `.voke/outputs/<stage>.json` as the source for smoke
  tests.
- Example `package.json` scripts: `"deploy": "voke deploy"`, `"remove": "voke remove"`.

### Step 9: Gated real-AWS proof (only with operator authorization)

With credentials and explicit approval, in `examples/hello-api`:

1. `voke deploy --stage <throwaway>`.
2. `curl <ApiUrl>/health` → 200 with `{"data":{"ok":true,...}}`.
3. `curl <ApiUrl>/users/usr_1` → 200.
4. `voke deploy` again → `No changes`.
5. `voke remove --stage <throwaway> --yes`.

Record the outputs. Without authorization, report this step as not run.

## Test plan

- **`packages/aws/test/zip.test.ts`**:
  - byte-identical output for identical input
  - entry order independent of input order
  - where `unzip` is on `PATH`, `unzip -p` returns the original contents and `unzip -Z` shows
    `rw-r--r--`
  - the size-limit error
- **`packages/aws/test/deploy.test.ts`**, with a fake `DeployAwsClients` that records calls and
  scripts responses. Pattern: `packages/core/test/aws-lambda-invoke-transport.test.ts`, or its
  `@voke/aws` successor after 009.
  - first deploy: bootstrap created, artifact and template uploaded once, change set `CREATE`,
    events printed, outputs returned
  - second deploy with an identical build: no `putObject` for the zip, `status: "unchanged"`
  - `ROLLBACK_COMPLETE`: the stack is deleted, then created
  - `UPDATE_IN_PROGRESS`: `VokeDeployError`, nothing executed
  - failed execution: the first failed resource and its reason are in the error
  - `dryRun`: the change set is described and deleted, `executeChangeSet` is never called
  - credential failure: mapped to the guidance message, no secret material in the output
  - remove: missing stack → `absent`, and the delete-failure reason is reported
  - an `artifactFiles` entry named `cloudformation.json` is excluded from the zip
- **`@voke/aws` synthesis tests**:
  - `artifact` produces `S3Bucket`/`S3Key` and no `ZipFile`
  - no artifact keeps the CommonJS placeholder
  - the stage is `$default`, and `ApiUrl` has no suffix
- **`packages/core/test/cli-contract.test.ts`**, with a fake provider object that has
  `deploy.deploy` and `deploy.remove`. No `@voke/aws` import is needed.
  - `voke deploy` and `voke remove` route to the provider
  - a provider without `deploy` gives the usage error, and so does no provider
  - stage `local` gives the usage error, but is allowed with an endpoint override
  - the outputs file is written, and not written on dry-run
  - remove confirmation: TTY prompt, `--yes`, non-TTY without `--yes`
  - `voke experimental deploy` is rejected as an unknown command
  - boolean flags
- **`packages/core/test/api.test.ts`**: replace the `experimental deploy/remove` tests (`:645-690`,
  `:843-...`) with provider-routed equivalents, or delete them where the contract tests cover
  them.

## Done criteria

- [ ] `bun run typecheck` and `bun run test` exit 0 (all workspaces, including the new
      `packages/aws/test/deploy.test.ts` and `zip.test.ts`)
- [ ] `bun run check` exits 0
- [ ] `grep -n "ProviderDeployCapability" packages/core/src/provider.ts packages/core/src/index.ts` matches in both files; `grep -n "deploy:" packages/aws/src/index.ts` matches inside `aws()`
- [ ] `grep -rnE "@aws-sdk/client-(cloudformation|s3)" packages/core` returns no matches; `grep -nE "client-(cloudformation|s3)" packages/aws/package.json` returns 2 matches
- [ ] `grep -rn "@voke/" packages/core/src --include=*.ts` shows no new import lines (only the existing template strings in `cli.ts`, `remote.ts` and `serverless-migration.ts`)
- [ ] `grep -n "export const handler = async () => ({ statusCode: 501" packages/aws/src/cloudformation-synthesis.ts` returns no matches (the placeholder uses `exports.handler`), and a test asserts that a template synthesized with an artifact contains no `ZipFile`
- [ ] `grep -rn "experimental" packages/core/src/cli.ts README.md apps/docs/content` returns no matches
- [ ] `grep -n '"cloudformation"' packages/core/src/cli.ts` returns no matches (the AWS-CLI deploy and remove code is gone)
- [ ] `voke --help` (`bun packages/core/src/cli.ts --help`) lists `voke deploy` and `voke remove`
- [ ] With `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` and `AWS_ENDPOINT_URL` unset, `cd packages/aws && bun test` and `cd packages/core && bun test` pass (no test reaches AWS)
- [ ] The new ADR file and `apps/docs/content/docs/guides/deploy.mdx` exist; `meta.json` lists `guides/deploy`
- [ ] Step 9 is either recorded with its outputs or explicitly reported as not run
- [ ] `git status --short` shows changes only to in-scope paths

## STOP conditions

- **009 has not landed.** `packages/core/src/cloudformation.ts` still exists and is used by
  `voke synth`, or `@voke/aws` synthesis emits no Runtime Variable IAM. Do not port the IAM here;
  report BLOCKED on 009.
- **003 has not landed, or its output differs.** `voke build` is not routed through
  `provider.build.plan`, or there is no manifest or generated Lambda entry, or the examples lack
  `provider: aws()` in `voke.config.ts`. Reconcile `artifactFiles` with the actual build plan;
  stop if the build output cannot identify the deployable files.
- **The owner reverses decision 1 or 2** (no Provider deploy capability, or no CloudFormation/S3
  SDK). Stop before Step 4. The AWS-CLI alternative changes Steps 4 and 6 and the test plan.
- **A consumer depends on the `/<stage>` URL suffix** beyond the tests listed here, so
  `$default` would break it.
- **009's per-Function IAM roles use explicit `RoleName`** and `CAPABILITY_NAMED_IAM` is not
  acceptable to the owner.
- **Step 9 lacks credentials or approval.** Finish everything else and report.
- **A real deployment shows AWS rejecting the template or bundle** for a reason not covered here.
  Report the event reason verbatim.

## Maintenance notes

- The artifact bucket gains one zip and one template per distinct build. Add a lifecycle rule
  later, but do not expire objects younger than the oldest stack that may roll back.
- Template limits: `TemplateURL` raises the size limit to 1 MB. CloudFormation caps a stack at
  500 resources.
- A second Provider would implement `ProviderDeployCapability` the same way. Keep CLI-owned
  behaviour (stage guard, build, confirmation, outputs file) out of `@voke/aws`.
- Future work here: per-Function artifacts, `voke deploy function <name>`, preview stages,
  removal policies and stage protection, custom domains, a CI workflow generator, and a
  `voke doctor` provider diagnostics capability (plan 006).
- Reviewers should scrutinise:
  - the stack-state machine
  - that no path executes a change set in dry-run
  - credential and permission error messages
  - that `remove` cannot run unconfirmed
  - that core gained no AWS import

## Execution notes (2026-11-14)

Done except Step 9, on branch `feature/one-command-deploy`, stacked on plan 008 (PR #54, open). Uncommitted.
Gates: `bun run check` 0 errors, `bun run typecheck` 18/18, `bun run test` 23/23 tasks (core 228, `@voke/aws`
51, `@voke/build` 4, `@voke/remote` 2, examples green). With `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` and
`AWS_ENDPOINT_URL` unset, `@voke/aws` and core tests pass (no test reaches AWS).

**Step 9 (real AWS) was not run:** no operator authorization or credentials were given.

Delivered:

- Core: `ProviderDeployCapability { deploy, remove }` with neutral `ProviderDeployInput`/`Result`/
  `ProviderRemoveInput`; `VokeDeployError` (`DEPLOY_ERROR`); `VokeError` exported.
- CLI: `voke deploy [--stage] [--region] [--config] [--dry-run]`, `voke remove [... --yes]`; boolean flags
  (`dry-run`, `force`, `help`, `verbose`, `yes`, also `--flag=false`); stage `--stage` → `VOKE_STAGE` →
  config; `local` refused without an endpoint; outputs printed `ApiUrl` first and written to
  `.voke/outputs/<stage>.json` (not on dry run); remove confirms by typing `<name>-<stage>` (injectable
  `confirm`/`interactive` in `CliOptions`), `--yes`, refusal outside a terminal. The `experimental` group and
  the AWS-CLI deploy/remove are gone; `build()` now returns its plan.
- `@voke/aws`: deterministic zip (`zip.ts`, verified with `unzip -p`/`unzip -Z`), `DeployAwsClients` seam
  with lazy CloudFormation/S3 SDKs and credential-error mapping, `deployAwsStack`/`removeAwsStack`
  (bootstrap stack + private encrypted bucket, content-addressed bundle and template, change-set state
  machine, dry run, event following, failure reasons), `aws().deploy`. Synthesis: optional `artifact`
  (`S3Bucket`/`S3Key`), CommonJS placeholder, `$default` stage, `ApiUrl` without suffix.
- Docs: ADR `docs/adr/0008-deploy-provider-capability.md` (0008 was free), `guides/deploy.mdx` (+ nav),
  README, CLI reference, getting started, e2e-testing; example `deploy`/`remove` scripts.

Deviations and findings:

- **Bootstrap template is inline** (`templateBody` on `ChangeSetInput`): the artifact bucket it creates cannot
  hold its own template.
- **Handlers come from `voke-manifest.json` at deploy time.** Plan 003 found that with explicit per-Function
  entrypoints the generated entry is not at the archive root; `deployAwsStack` patches each Function's
  `Handler` from the manifest, so deployed handlers always match the bundle.
- **Following a stack also polls its status**, so a deleted stack (not describable by name) or a terminal
  status between event polls ends the wait; a stack left in `REVIEW_IN_PROGRESS` by a dry run is created
  again, and a dry-run CREATE deletes its empty stack.
- **`CAPABILITY_IAM` only**: plan 009's per-Function roles set no `RoleName`.
- Contract tests live in a new `packages/core/test/deploy-cli.test.ts` instead of `cli-contract.test.ts`; the
  two `experimental` tests were removed from `cli-contract.test.ts`, and `api.test.ts` lost its
  `experimental` config test (covered by the new contract tests) and kept its synth half.
- `zip.ts` disables `no-bitwise` and `unicorn/prefer-math-trunc` with a stated reason (binary format;
  `>>> 0` is an unsigned conversion).
