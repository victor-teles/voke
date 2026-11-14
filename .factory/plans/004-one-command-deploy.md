# Plan 004: `voke deploy` takes a project from source to a live URL in one command

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/src packages/core/test packages/core/package.json README.md apps/docs/content docs examples/e2e`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `.factory/plans/002-node-lambda-runtime-portability.md`, `.factory/plans/003-registry-discovery-and-lambda-entries.md`
- **Category**: direction
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

Voke has no working path to AWS. The synthesized Lambda contains a placeholder that answers
501, the experimental deploy command uploads no code, and the README documents commands the
CLI rejects. "Easy to deploy" is the product goal, so this is the largest gap in the
repository. After this plan, `voke deploy --stage dev` builds, packages, uploads, deploys
through CloudFormation, shows progress, and prints the API URL, with no AWS CLI installed.
`voke remove` tears the stage down safely.

## Current state

- Placeholder code in every synthesized Lambda, `packages/core/src/cloudformation.ts:752-756`:
  ```ts
  Code: {
    ZipFile:
      "export const handler = async () => ({ statusCode: 501, body: 'Build and upload this Voke function before deploying.' });",
  },
  ```
  Nothing zips build output, uploads it, or rewrites `Code`.
- `packages/core/src/cli.ts:483-503` — `deploy()` shells out to
  `aws cloudformation deploy --stack-name <name>-<stage> --template-file <template> --capabilities CAPABILITY_IAM --region <region>`.
  It requires the AWS CLI, does not build or synth, shows no outputs, and deploys the 501 stub.
- `cli.ts:466-481` — `remove()` runs `aws cloudformation delete-stack` and returns immediately:
  no confirmation, no wait, no result.
- `cli.ts:783-787` — top-level `voke deploy`/`voke remove` throw
  `Deployment commands are experimental. Use: voke experimental deploy`. `README.md:84-85` and
  `apps/docs/content/docs/reference/cli.mdx` ("Deploy and remove") present them as working
  top-level commands.
- `cli.ts:131-168` — `parseFlags` requires a value for every `--flag` (`Missing value for --key`).
  Boolean flags such as `--yes` are impossible today.
- Default stage is `local` (`packages/core/src/config.ts:189`: `input.stage ?? VOKE_STAGE ?? STAGE ?? "local"`),
  and examples hardcode `stage: "local"`. A plain deploy would create a real stack named `<name>-local`.
- Named API stage: `cloudformation.ts:577-584` creates `AWS::ApiGatewayV2::Stage` with
  `StageName: model.service.stage`, and the `ApiUrl` output ends in `/<stage>`
  (`cloudformation.ts:628-632`). With a named stage, HTTP API payload v2 puts the stage in
  `rawPath` (`/dev/health`). The Gateway matches on `rawPath`; in a scratch run of a Node bundle,
  an event with `rawPath: "/dev/health"` returned `404 Route not found` while `/health` returned 200. Every route would 404 on a deployed named stage.
- Stack naming: `stackName(name, stage)` → `<name>-<stage>` (`cli.ts:170`). Function names:
  `<name>-<stage>` for the API function, `<name>-<stage>-<key>` for others (`model.ts:460-463`).
- Template shape today (hello-api): `FunctionRole` (one shared role), `Function`, `Api`,
  `Integration`, `Route`, `Stage`, `Permission`, resources from config, and outputs `ApiUrl`,
  `FunctionName`, plus one per resource (e.g. `UsersTableName`).
- Only AWS dependency: `@aws-sdk/client-lambda` (`packages/core/package.json`). ADR
  `docs/adr/0001-aws-sdk-lambda-invoke-transport.md` chose the AWS SDK for Lambda invocation.
- Test seam to copy: `packages/core/src/aws-lambda-invoke-transport.ts:13-15` defines a narrow
  `AwsLambdaInvokeClient` interface so tests inject a fake instead of calling AWS.
- CLI functions accept an injected `run: CommandRunner` and `output: CliOutput`
  (`cli.ts:20-36`); `test/cli-contract.test.ts` and `test/api.test.ts` assert the experimental
  commands through that seam.
- After plan 003, `voke build` writes `<outdir>/index.js`, `<outdir>/package.json`
  (`{"type":"module"}`), and `<outdir>/voke-manifest.json`; `loadProject` gives the config with
  the discovered Function Registry.
- Local emulator path: `packages/core/src/local-provider.ts:109-126` (`voke local bootstrap`)
  also shells out to `aws cloudformation deploy` with the stub template. It keeps working
  unchanged in this plan.
- `examples/e2e/test/deployed-smoke.e2e.test.ts` and `docs/e2e-testing.md` describe smoke tests
  against a deployed `ApiUrl` output.

## Decisions taken in this plan

1. **AWS SDK, not the AWS CLI.** Add `@aws-sdk/client-cloudformation` and `@aws-sdk/client-s3`
   as dependencies of `packages/core`, imported only from CLI-time modules. Reason: removes the
   AWS CLI prerequisite, gives structured progress and errors, uses the standard credential
   chain (profiles, SSO, environment, OIDC in CI). `@aws-sdk/*` is external to runtime bundles
   (plan 002), so Lambda bundle size does not change. The owner may veto this; see STOP conditions.
2. **`$default` API stage.** One stack per Voke stage already isolates environments, so the HTTP
   API uses the `$default` stage and the URL has no stage suffix. This removes the `rawPath`
   prefix problem at the source.
3. **`local` is reserved for the emulator.** `voke deploy` refuses stage `local` unless a custom
   AWS endpoint is configured, and tells the user to pass `--stage dev`.
4. **One artifact per deploy**, content-addressed, shared by all Functions in the stack.

## Commands you will need

| Purpose                 | Command                                                                                    | Expected on success                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Install                 | `bun install`                                                                              | exit 0                                                                               |
| Add deps                | `cd packages/core && bun add @aws-sdk/client-cloudformation @aws-sdk/client-s3`            | exit 0, lockfile updated                                                             |
| Core tests              | `cd packages/core && bun test`                                                             | all pass                                                                             |
| One test file           | `cd packages/core && bun test test/deploy.test.ts`                                         | all pass                                                                             |
| Core typecheck          | `cd packages/core && bun run typecheck`                                                    | exit 0                                                                               |
| Repo gates              | `bun run typecheck && bun run test`                                                        | exit 0                                                                               |
| Lint/format             | `bun run check`                                                                            | exit 0                                                                               |
| Dry run (no AWS writes) | `cd examples/hello-api && bun ../../packages/core/src/cli.ts deploy --stage dev --dry-run` | prints the plan; needs AWS credentials for change-set preview only if a stack exists |

## Implementation rules relevant to this plan

- Test first. All AWS interaction goes through a narrow injected interface so unit tests use
  fakes. No test may call real AWS or the network by default.
- **Do not deploy to a real AWS account, create buckets, or delete stacks unless the operator
  explicitly authorizes it and provides credentials.** Real-AWS proof is a separate, gated step.
- Never print or log credential values. Error messages may name the credential source type
  (profile, environment, SSO) but not contents.
- CLI errors: `CliUsageError` for bad invocations; a new `VokeDeployError extends VokeError`
  (in `packages/core/src/errors/`, exported from `errors.ts`, following
  `packages/core/src/errors/config.ts`) for AWS and stack failures. Messages say what failed,
  which resource, and the next step (`docs/error-conventions.md`).
- CLI-time modules may use Bun APIs. Runtime modules must not (plan 002).
- Keep `voke synth` output deterministic: without an artifact reference it still emits the
  placeholder `ZipFile` so `voke synth` works offline.
- Use `node:path` and `node:fs/promises` for paths and directories in new code (no `split("/")`,
  no `mkdir -p` through the shell).

## Scope

**In scope**:

- `packages/core/src/deploy.ts` (create), `packages/core/src/zip.ts` (create), `packages/core/src/aws-deploy-clients.ts` (create), `packages/core/src/errors/deploy.ts` (create), `packages/core/src/errors.ts`
- `packages/core/src/cli.ts` (flag parsing, `deploy`, `remove`, help text, top-level commands)
- `packages/core/src/cloudformation.ts` (artifact `Code`, `$default` stage, `ApiUrl` output), `packages/core/src/model.ts` only if the artifact reference needs a model field
- `packages/core/package.json`, `bun.lock`
- `packages/core/test/deploy.test.ts`, `test/zip.test.ts` (create); updates to `test/cli-contract.test.ts`, `test/api.test.ts`, `test/cloudformation.test.ts`, `test/e2e.test.ts`
- `examples/e2e/test/*.e2e.test.ts` (URL shape only), example `package.json` scripts (`deploy`, `remove`)
- `README.md`, `apps/docs/content/docs/reference/cli.mdx`, `apps/docs/content/docs/getting-started.mdx`, `apps/docs/content/docs/guides/deploy.mdx` (create), `apps/docs/content/docs/meta.json`, `docs/e2e-testing.md`
- `docs/adr/0008-deploy-pipeline.md` (create; short ADR recording decisions 1–4)
- `.factory/plans/README.md` (status only)

**Out of scope**:

- `voke local bootstrap` and the Floci provider. They keep the current behavior.
- Custom domains, per-Function bundles, single-Function fast deploy, preview-stage commands, CI
  workflow generation (roadmap v2 phases 6 and 7).
- Removal policies and stage protection config (roadmap v2 phase 1, issue #36 area). This plan
  adds only an interactive confirmation for `remove`.
- Lambda memory/timeout/logging defaults (plan 005).

## Git workflow

- Branch: `feature/one-command-deploy`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Boolean flags in the CLI parser

Extend `parseFlags` with a set of boolean flag names (`yes`, `dry-run`, `verbose`, `help`,
`force`): they take no value and are stored as `"true"`. `--flag=false` is allowed. All other
flags keep today's behavior, including the `Missing value for --key` error. Add tests in
`test/cli-contract.test.ts`.

### Step 2: Deterministic zip writer

Create `packages/core/src/zip.ts`:

```ts
export interface ZipEntry { path: string; data: Uint8Array; }
export const createZip = (entries: ZipEntry[]): Uint8Array;
```

Requirements: DEFLATE via `node:zlib` (`deflateRawSync`), CRC-32, entries sorted by path, a
fixed timestamp for every entry (so identical input gives identical bytes), forward-slash paths,
"version made by" set to Unix with mode `0o644` in the external attributes (Lambda rejects
unreadable files). No new dependency. Files over 4 GiB and ZIP64 are not needed; throw if an
entry or the archive would exceed the classic limits.

### Step 3: AWS client seam

Create `packages/core/src/aws-deploy-clients.ts` with a narrow interface and a default
implementation backed by the SDK (loaded with dynamic `import()` so other commands start fast):

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
```

Region and endpoint come from `createAwsClientConfig` (`packages/core/src/aws.ts`), so
`AWS_ENDPOINT_URL` keeps working for emulators. Map SDK credential errors to `VokeDeployError`
with the message: `AWS credentials were not found or have expired. Configure a profile
(AWS_PROFILE), run your SSO login, or set environment credentials, then retry.`

### Step 4: Synthesis accepts an artifact and uses the `$default` stage

- `synthesizeCloudFormation` gains an optional `artifact?: { bucket: string; key: string }`.
  With it, every Function whose handler comes from the shared bundle gets
  `Code: { S3Bucket, S3Key }`; without it, the placeholder stays.
- Fix the placeholder itself: inline `ZipFile` code is saved as `index.js` and loaded as
  CommonJS, so today's `export const handler = ...` fails with
  `Runtime.UserCodeSyntaxError: Unexpected token 'export'` (observed on AWS Emulator 1.0.367).
  Write it as `exports.handler = async () => ({ statusCode: 501, body: "..." });`.
- Change the API stage to `StageName: "$default"` and the `ApiUrl` output to
  `https://${Api}.execute-api.${AWS::Region}.amazonaws.com` (no suffix). Update the expectations
  that contain `amazonaws.com/<stage>`: `test/api.test.ts:786`, `test/e2e.test.ts:248,265`,
  `examples/e2e/test/local-floci.e2e.test.ts:19,38`.

### Step 5: Deploy pipeline

Create `packages/core/src/deploy.ts` exporting `deployProject(options)` and
`removeProject(options)`; both take `{ config, clients, output, now?, confirm? }` so tests
control everything. `deployProject` steps:

1. **Resolve** stage (`--stage` → `VOKE_STAGE` → config), region, stack name `<name>-<stage>`.
   Stage `local` with no custom endpoint → `CliUsageError`:
   `Stage "local" is reserved for the local emulator. Deploy to AWS with: voke deploy --stage dev`.
2. **Build** through the existing build function (plan 003 output). Fail if
   `<outdir>/index.js` is missing.
3. **Package**: zip every file in the build outdir except `cloudformation.json` and
   `*.zip`; key `<name>/<stage>/<sha256 of zip, first 16 hex>.zip`. Print bundle size.
4. **Bootstrap**: ensure stack `voke-bootstrap` exists in the region with one private,
   encrypted S3 bucket (`PublicAccessBlockConfiguration` all true, `BucketEncryption` AES256) and
   output `ArtifactBucketName`. Create it through the same change-set path if absent.
5. **Upload** the zip unless `objectExists`. Upload the synthesized template to
   `<name>/<stage>/template-<hash>.json` and deploy with `TemplateURL` (inline templates are
   limited to 51,200 bytes).
6. **Change set**: type `CREATE` when the stack is absent, `UPDATE` otherwise; capabilities
   `CAPABILITY_IAM`. Handle states: `ROLLBACK_COMPLETE` → delete the failed stack, then create;
   any `*_IN_PROGRESS` → error "A deployment is already in progress for <stack>"; `UPDATE_ROLLBACK_FAILED`
   → error with the console action to take. An empty change set ("didn't contain changes") is
   success: print `No changes` and the outputs, delete the change set.
7. **`--dry-run`**: stop after describing the change set; print each change
   (`Add | Modify | Remove`, logical id, resource type); delete the change set. The artifact and
   template are still uploaded because the change set references them, but nothing is executed.
8. **Execute and follow**: poll `describeStackEvents` (injectable interval; default 2 s) and
   print one line per resource status change. On failure, print the first `*_FAILED` event's
   logical id and reason, then throw `VokeDeployError`.
9. **Outputs**: print `ApiUrl` first, then the rest; write
   `.voke/outputs/<stage>.json` (`{ stack, region, stage, outputs: Record<string, string> }`).

`removeProject`: require confirmation by typing the stack name when stdin is a TTY; `--yes`
skips it; non-TTY without `--yes` → `CliUsageError`. Then `deleteStack`, follow events until
`DELETE_COMPLETE`, and report resources that failed to delete (for example a non-empty bucket)
with the reason. A missing stack is success with `Nothing to remove`.

### Step 6: CLI wiring

- `voke deploy [--stage <stage>] [--region <region>] [--config <path>] [--dry-run] [--verbose]`
- `voke remove [--stage <stage>] [--region <region>] [--config <path>] [--yes]`
- Both load config with `loadConfigFromFlags` and the project with `loadProject`.
- Remove the "Deployment commands are experimental" rejection and delete the `voke experimental`
  command group entirely (ADR `docs/adr/0007-opinionated-framework.md`: removals happen without
  aliases while the package is unreleased). `voke experimental ...` becomes an unknown command.
  Update `printHelp` and `commandUsage`.
- Output goes through `options.output ?? console.log` so tests capture it. Example:

  ```
  Building hello-api (dev)            index.js 109 KB
  Uploading artifact                  done
  Deploying stack hello-api-dev
    CREATE_COMPLETE  AWS::Lambda::Function      Function
    CREATE_COMPLETE  AWS::ApiGatewayV2::Api     Api
  Deployed in 48s

  ApiUrl  https://abc123.execute-api.us-east-1.amazonaws.com
  ```

### Step 7: Docs and ADR

- `docs/adr/0008-deploy-pipeline.md`: context, the four decisions above, consequences. Match the
  format of `docs/adr/0006-http-api-authorizers.md`.
- `apps/docs/content/docs/guides/deploy.mdx` (new, linked in `meta.json`): credentials,
  `voke deploy --stage dev`, what gets created (bootstrap stack and bucket, app stack),
  `--dry-run`, outputs file, `voke remove`, the reserved `local` stage, minimal IAM actions the
  deploying identity needs (CloudFormation, S3 on the artifact bucket, IAM role create/pass,
  Lambda, API Gateway, plus services for declared resources).
- `README.md`: CLI list matches the real commands; add a "Deploy" section; remove the old
  `--template` usage. `apps/docs/content/docs/reference/cli.mdx` and `getting-started.mdx`:
  same corrections, and add the deploy step to getting started.
- `docs/e2e-testing.md`: URL shape and `.voke/outputs/<stage>.json` as the source for smoke tests.

### Step 8: Gated real-AWS proof (only with operator authorization)

With credentials and explicit approval: in `examples/hello-api`, run
`voke deploy --stage <throwaway>`, `curl <ApiUrl>/health` (expect 200 and
`{"data":{"ok":true,...}}`), `curl <ApiUrl>/users/usr_1` (expect 200), `voke deploy` again
(expect `No changes`), then `voke remove --stage <throwaway> --yes`. Record the outputs in the
final report. Without authorization, report this step as not run.

## Test plan

- `test/zip.test.ts`: byte-identical output for identical input; entry order independent of input
  order; where `unzip` is on `PATH`, `unzip -p` returns the original file contents and
  `unzip -Z` shows `rw-r--r--`; size-limit error.
- `test/deploy.test.ts` with a fake `DeployAwsClients` that records calls and scripts responses:
  - first deploy: bootstrap created, artifact and template uploaded once, change set `CREATE`,
    events printed, outputs printed and written
  - second deploy with identical build: no `putObject` for the zip, `No changes`
  - stack in `ROLLBACK_COMPLETE`: deleted, then created
  - stack in `UPDATE_IN_PROGRESS`: error, nothing executed
  - failed execution: first failed resource and reason in the error; non-zero path
  - `--dry-run`: change set described and deleted, `executeChangeSet` never called
  - stage `local`: usage error; allowed when an endpoint override is set
  - credential failure mapped to the guidance message, no secret material in output
  - remove: confirmation required; `--yes`; non-TTY without `--yes`; missing stack
- `test/cloudformation.test.ts`: `artifact` produces `S3Bucket`/`S3Key`; absent artifact keeps
  the placeholder; `$default` stage; `ApiUrl` without suffix.
- `test/cli-contract.test.ts`: `voke deploy`/`voke remove` route to the new functions;
  `voke experimental deploy` is rejected as an unknown command; boolean flags.
- Structural pattern: `packages/core/test/aws-lambda-invoke-transport.test.ts` for fake-client
  tests; `packages/core/test/cli-contract.test.ts` for CLI routing.

## Done criteria

- [ ] `cd packages/core && bun test` → 0 fail, including `test/deploy.test.ts` and `test/zip.test.ts`
- [ ] `bun run typecheck` and `bun run check` exit 0
- [ ] `grep -rn "Build and upload this Voke function" packages/core/src` matches only the offline-synth placeholder path, and a template synthesized with an artifact contains no `ZipFile`
- [ ] `voke deploy` and `voke remove` are top-level commands in `voke --help`; `grep -rn "experimental" packages/core/src/cli.ts README.md apps/docs/content` returns no matches
- [ ] `grep -rn '"aws", *"cloudformation"' packages/core/src/cli.ts` returns no matches (the Floci provider in `local-provider.ts` is unchanged)
- [ ] No test performs a real network call (the suite passes with networking disabled or with `AWS_ACCESS_KEY_ID` unset)
- [ ] ADR 0008 and the deploy guide exist; README, CLI reference, and getting started describe the real commands
- [ ] Real-AWS proof (step 8) is either recorded with its outputs or explicitly reported as not run
- [ ] No files outside the in-scope list are modified

## STOP conditions

- The owner rejects adding `@aws-sdk/client-cloudformation` and `@aws-sdk/client-s3`. Stop before
  step 3; the alternative (keep shelling out to the AWS CLI with `aws cloudformation package`/`deploy`)
  changes steps 3, 5, and the test plan.
- Step 8 needs credentials or approval that were not given. Finish everything else and report.
- The `$default` stage change conflicts with a consumer that depends on the `/<stage>` URL suffix
  beyond the tests listed in step 4.
- Plan 003 output differs from what this plan assumes (`index.js`, `package.json`,
  `voke-manifest.json` in the build outdir). Reconcile with the actual build plan before step 5.
- A real deployment shows API Gateway or Lambda rejecting the synthesized template or bundle for a
  reason not covered here. Report the event reason verbatim.

## Maintenance notes

- The artifact bucket accumulates one zip and one template per distinct build. Add a lifecycle
  rule later; do not expire objects younger than the oldest stack that may roll back.
- Template size: resources grow with routes. `TemplateURL` raises the limit to 1 MB; CloudFormation
  also caps a stack at 500 resources. Plan 003 keeps this low with one integration per Function.
- Future work that will touch this code: per-Function artifacts, `voke deploy function <name>`,
  preview stages, removal policies and stage protection, custom domains, a CI workflow generator.
- Reviewers should scrutinize: the stack-state machine, that no path executes a change set in
  `--dry-run`, error messages on credential and permission failures, and that `remove` cannot run
  unconfirmed.
