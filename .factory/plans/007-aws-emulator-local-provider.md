# Plan 007: `voke local` and `voke dev` run against the official AWS Emulator with real stack outputs

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; report status to it instead of editing the index.
>
> **Drift check**: Compare `git diff --stat 3435023 -- packages/aws packages/core/src/provider.ts packages/core/src/cli.ts packages/core/src/dev.ts packages/core/test examples/hello-api examples/e2e README.md docs apps/docs/content`
> and `git status --short` with the recorded state below. Plans 009, 003, 008, 004, 010, 005 and 006
> run before this one and change these files. Reconcile with "Expected state after earlier plans".
> Pause if drift invalidates scope, a protected contract, or an unresolved product decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `.factory/plans/010-local-workflow-through-provider.md` (required: typed `ProviderLocalWorkflow`, async `devEnvironment` with `unsetEnvironment`, `unsetEnv` in the CLI runner, `aws({ local })`, `floci()`). It uses `.factory/plans/004-one-command-deploy.md` only for the SDK bootstrap path (Step 4a). If 004's CloudFormation client seam is not in `@voke/aws`, use the CLI fallback (Step 4b). It also edits CLI help/docs touched by 006; the coordinator's order puts it last: … → 010 → 005 → 006 → **007**.
- **Category**: dx
- **Planned at**: commit `3435023`, 2026-11-14 (first written at `a7741eb`; rewritten after the core/provider package split)

## Why this matters

AWS released an official local emulator on 2026-11-11. It answers AWS API calls with AWS's own
validation and errors, starts in seconds, and its CloudFormation can provision the resources a Voke
project declares. Using it gives Voke developers a local loop that behaves like the cloud: real
generated resource names, real queue URLs, and deploy-time mistakes caught on a laptop. Today the
only Local AWS Provider is Floci, local bindings are guessed from logical ids, and credentials are
fixed dummy keys. None of that works with this emulator, and the guessed names never match what
CloudFormation generates.

## What the emulator is (verified 2026-11-14, version 1.0.367)

Read from the announcement, the repository README, and the user guide
(`https://docs.aws.amazon.com/emulator/latest/userguide/`), then tested in Docker on an arm64 Mac
with AWS CLI 2.34.45, Bun 1.4.4, and Node 24.14.

**Packaging and lifecycle**

- Published by AWS at `github.com/aws/aws-emulator`. License CC0-1.0 (`vendor/` is Apache-2.0).
  No fee. Not for production or security testing.
- No prebuilt Docker image. The documented path is a Dockerfile that installs the Linux package:
  ```dockerfile
  FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
  ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-x86_64.rpm /tmp/aws-emulator.rpm
  RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
      && mkdir -p /home/emulator && chown 1000 /home/emulator
  USER 1000
  ENV HOME=/home/emulator
  EXPOSE 9297
  ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
  ```
  Arm hosts use `aws-emulator-aarch64.rpm`. Pinned packages are named
  `aws-emulator-<version>-1-<arch>.rpm`. Measured: build 35 s, image 1.23 GB.
- Native install exists only for Linux (RPM/DEB, binary `aws-emulator`). macOS and Windows need Docker.
- Options: `-p/--port` (default `9297`, `0` = OS picks), `-b/--bind`, `-a/--auth on|off`,
  `-t/--telemetry on|off` (default **on**), `--idle-timeout <seconds>`, `-v`, `-h`.
- Measured start: ready in about 3 s. Health: `GET /__admin/health` → `200 ok`.
- State is in memory only. No reset route; restart to reset. Stopping deletes the port's files.
- Docs recommend `--memory=2g --memory-swap=2g` and publishing on `127.0.0.1` only.

**Endpoint, TLS, credentials**

- HTTPS only, self-signed CA generated on every start.
- On start it writes `~/.aws/emulator/<port>/` (inside the container: `/home/emulator/.aws/emulator/<port>/`):
  `emulator_credentials`, `config`, `ca.pem`, `truststore.p12`. Mounting a project directory at
  `/home/emulator/.aws/emulator` puts those files in the project (tested). The generated `config`
  contains the container's CA path, so it is not usable from the host as is.
- Credentials are generated per run. Fixed dummy keys are rejected: `test`/`test` returned
  `InvalidClientTokenId` (tested).
- Account `000000000000`, identity `arn:aws:iam::000000000000:user/emulator`.
- Environment the docs prescribe for clients:
  `AWS_ENDPOINT_URL`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_CA_BUNDLE`,
  `AWS_EC2_METADATA_DISABLED=true`, `AWS_DISABLE_HOST_PREFIX_INJECTION=true`, `AWS_REGION`,
  `AWS_DEFAULT_REGION`, plus `NODE_EXTRA_CA_CERTS` for the JavaScript SDK; and **unset**
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`.
- Tested under Bun 1.4.4: with `NODE_EXTRA_CA_CERTS` set, `fetch` and the AWS SDK reach the
  emulator; without it both fail with `self signed certificate`.

**What worked**

- STS, SQS (send/receive), DynamoDB (table is `CREATING` first, like AWS; use a waiter), S3
  (path-style), SNS, EventBridge bus, Secrets Manager, SSM Parameter Store.
- CloudFormation: a Voke-shaped template (SQS queue, DynamoDB table, IAM role with inline policy,
  Lambda function, SQS event source mapping, HTTP API, integration, route, `$default` stage,
  Lambda permission, outputs) reached `CREATE_COMPLETE` in about 10 s through
  `aws cloudformation deploy` (change sets). A second deploy reported "No changes to deploy".
- It validates like AWS: the same stack without SQS permissions on the role failed with
  `The function execution role does not have permissions to call ReceiveMessage on SQS` and rolled back.
- Stack outputs carry generated physical names:
  `UsersTableName = probe-dev-UsersTable-EF186B141961`,
  `EventsQueueUrl = https://sqs.us-east-1.amazonaws.com/000000000000/probe-dev-EventsQueue-23CEB2527CB9`.
- Lambda: `CreateFunction`, `UpdateFunctionCode` with a zip, direct `Invoke`, invocation through
  the HTTP API route, the SQS trigger, and CloudWatch Logs all worked for a small hand-written handler.

**What did not work**

- **A Voke bundle cannot run inside the emulator's Lambda.** Its JavaScript runtime is not
  Node.js: it reports `node 22.0.0` but has no `fetch`, `Request`, `Response`, `Headers`,
  `ReadableStream`, or `structuredClone`, and no `node:module`, `node:http`, `node:https`,
  `node:zlib`, `node:async_hooks`. The Gateway is built on Hono, which needs `Request`/`Response`.
  The Node-target bundle failed at import with `Runtime.ImportModuleError: Cannot find module 'node:module'`.
- **Queue URLs point at the real AWS host.** With only `AWS_ENDPOINT_URL` in the environment, the
  JavaScript SDK's SQS client used the QueueUrl host and sent the request to
  `sqs.us-east-1.amazonaws.com` (rejected with `InvalidClientTokenId`). With an explicit
  `endpoint` in the client constructor, send and receive went to the emulator.
  `createAwsClientConfig()` in `@voke/aws` (`packages/aws/src/resources.ts:67-85` at 3435023) returns
  an explicit `endpoint` when `VOKE_AWS_ENDPOINT_URL` or `AWS_ENDPOINT_URL` is set, so clients built
  from it are safe.
- An emulator-side event source mapping delivers queue messages to the emulator's Lambda and
  deletes them. With a placeholder function there, messages would vanish.

**Consequence for the design**: use the emulator for resources and the control plane. Keep
running Function code in the local Gateway (`voke dev`, real Bun), which is Voke's local model.
Do not deploy Lambdas, APIs, or event source mappings to the emulator.

## Current state

Vocabulary (`CONTEXT.md`): **Provider** (the `aws()` platform adapter set in `voke.config.ts`),
**Provider Capability**, and **Local AWS Provider** ("a local development implementation that
emulates AWS services for a Voke Project", distinct from a Provider). The AWS Emulator and Floci are
both Local AWS Providers. Name code and docs accordingly; never call the emulator "the provider".

ADRs that bind this plan:

- `docs/adr/0007-specialized-provider-and-helper-packages.md`: `@voke/aws` "owns the full AWS
  workflow, including ... local AWS workflow helpers, and CloudFormation synthesis". Core
  (`packages/core`, package `voke`) stays provider-neutral and must not import `@voke/*`.
- `docs/adr/0007-opinionated-framework.md`: the supported path includes "the AWS Emulator for local
  resources with Function code running in the local Gateway"; "the `LocalProvider` interface for
  local emulation" is the local layer's escape hatch; removals happen without aliases.
- User decision U3: AWS-only settings are provider options, `aws({ local: awsEmulator() })`.
  The AWS Emulator becomes the default Local AWS Provider. Floci remains available as `floci()` from
  `@voke/aws/local`.

At 3435023 (before 009/010), for orientation:

- `packages/aws/src/local-provider.ts`: `LocalProvider` (`:67-78`) is Docker Compose shaped
  (`composeConfig`, and `startCommand`/`stopCommand`/`resetCommand` taking `{ composePath }`) with a
  synchronous `environment`. `LocalAwsEnvironment` (`:3-13`) requires `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`; Floci fills them with `test`. `LocalProviderError`
  is at `:82-99`. Floci is at `:106-203`.
- `packages/aws/src/local.ts:101-195` guesses bindings: table name = logical id, queue URL =
  `${endpoint}/${accountId}/${logicalId}`, topic ARN from the logical id, and so on.
- `packages/aws/src/cloudformation-synthesis.ts:690` `synthesizeCloudFormationFromModel(model)`.
  Each resource gets `Metadata.VokeBinding = { Attribute, Resource }` (`:704-709`), and the template
  carries `Outputs` (`:846`), built from model outputs `<LogicalId><Attribute>`
  (`packages/core/src/model.ts:468`), e.g. `UsersTableName`, `EventsQueueUrl`.
- `createResourceBindingName` is in `packages/aws/src/resources.ts:38` and produces `VOKE_RESOURCE_<NAME>_<ATTR>`.
- `packages/aws/src/testing.ts:133` `createStackTestContext` uses the guessed bindings.

### Expected state after earlier plans (verify; do not redo)

- **009**: core has no AWS copies. CloudFormation synthesis lives only in `@voke/aws`; resource
  builders are in `@voke/aws/cloudformation` (U4).
- **010**:
  - `packages/core/src/provider.ts` has `ProviderLocalWorkflow { start, stop, reset, bootstrap }`
    taking `ProviderLocalWorkflowContext { config, model, options, run }`.
  - `devEnvironment` may be async and returns `{ environment, unsetEnvironment? }`.
  - `ProviderCommandRunner` options support `unsetEnv`, and `voke dev` passes
    `DevPlan.unsetEnvironment` to its child.
  - `aws(options)` accepts `local?: LocalProvider`, defaulting to `floci()`.
  - `@voke/aws/local` exports `floci` and `createLocalWorkflow(provider)`.
  - Core config and model have no `local`. Core `local.ts`, `local-provider.ts` and `e2e.ts` are gone.
- **004** (optional for this plan): a CloudFormation client seam and stack routine (change set →
  execute → follow events → outputs) inside `@voke/aws`, with SDK dependencies in
  `packages/aws/package.json`. Record the actual file and function names you find.
- **006**: may have added a provider `diagnostics` capability for `voke doctor`.
- ADR numbering: three ADRs share 0007. Do not assume a number; use the next free one at execution time.

## Decisions taken in this plan

1. **Resources on the emulator, code in the local Gateway.** Local bootstrap deploys a
   resources-only template. No Lambda, API Gateway, IAM role, or event source mapping is created locally.
2. **AWS Emulator is the default Local AWS Provider.** `aws()` with no `local` option uses
   `awsEmulator()`. Floci stays available as `aws({ local: floci() })` for projects that need
   persistent local state or no 1.2 GB image.
3. **Bindings come from stack outputs**, written to `.voke/local/outputs.json` by bootstrap and read
   by `voke dev`. The guessing code remains only for Floci.
4. **Project-local state**: emulator files live in `.voke/local/aws-emulator/<port>/`, not in
   `~/.aws`. Voke never reads, copies, or prints the generated keys; it passes file paths.
5. **Telemetry off by default** for emulators Voke starts (`-t off`); `awsEmulator({ telemetry: true })` opts in.
6. **Docker on every platform in v1.** A native Linux binary and externally managed emulators are follow-ups.

## Commands you will need

| Purpose                                                | Command                                                                         | Expected on success |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------- |
| Install                                                | `bun install`                                                                   | exit 0              |
| AWS package tests                                      | `cd packages/aws && bun test`                                                   | 0 fail              |
| One test file                                          | `cd packages/aws && bun test test/local.test.ts`                                | 0 fail              |
| Core tests (CLI/dev plumbing)                          | `cd packages/core && bun test`                                                  | 0 fail              |
| Package typecheck                                      | `cd packages/aws && bun run typecheck`                                          | exit 0              |
| Repo gates                                             | `bun run typecheck && bun run test`                                             | exit 0              |
| Lint/format check                                      | `bun run check`                                                                 | exit 0              |
| Emulator e2e (needs Docker, downloads the AWS package) | `cd packages/aws && VOKE_E2E_EMULATOR=1 bun test test/aws-emulator.e2e.test.ts` | 0 fail              |

## Implementation rules relevant to this plan

- Test first. Unit tests use an injected command runner and fake clients; they must not start
  Docker or use the network. The real-emulator test is gated behind `VOKE_E2E_EMULATOR=1`.
- All new code lives in `packages/aws`. Do not change core contracts. If a core change seems
  necessary, that is a STOP condition: 010 owns the contract.
- Never read, log, or print the contents of `emulator_credentials`. Pass its path through
  `AWS_SHARED_CREDENTIALS_FILE` (or the SDK's ini provider with a filepath).
- Child processes started for the emulator must not inherit real AWS credentials or profiles.
  Use `unsetEnv` / `unsetEnvironment`.
- Publish the container port on `127.0.0.1` only.
- Local workflow code is CLI-time and may use Bun APIs. Lambda runtime modules must not (plan 002).
- Errors: `LocalProviderError` (in `packages/aws/src/local-provider.ts`), with a message that names
  the failing command and the next step.
- No new dependencies beyond what 004 added to `packages/aws/package.json`.
- Floci behavior stays unchanged, as verified by the existing Floci tests in `packages/aws/test/local.test.ts`.

## Scope

**In scope**:

- `packages/aws/src/local-provider.ts`, `packages/aws/src/local-aws-emulator.ts` (create),
  `packages/aws/src/local.ts`, `packages/aws/src/index.ts` (default Local AWS Provider,
  `devEnvironment`), `packages/aws/src/cloudformation-synthesis.ts` (resources-only option),
  `packages/aws/src/resources.ts` (doc comment on `createAwsClientConfig`), and the 004 deploy
  client/stack modules in `packages/aws/src` (inline template body, CA and credentials-file options)
- `packages/aws/test/local.test.ts`, `packages/aws/test/aws-emulator.e2e.test.ts` (create), the
  synthesis tests in `packages/aws/test`, `packages/aws/test/provider.test.ts`
- `packages/core/test/cli-contract.test.ts` and `dev.test.ts`: assertions that depend on the default
  Local AWS Provider only
- `packages/core/test/public-surface.test.ts` (the `@voke/aws/local` export list)
- `examples/hello-api/src/local.ts`, `examples/e2e/test/local-floci.e2e.test.ts` (make it select
  `floci()` explicitly)
- `README.md` (local section), `apps/docs/content/docs/guides/local-aws.mdx` (create),
  `apps/docs/content/docs/meta.json`, `docs/e2e-testing.md`, `docs/adr/<next-free>-aws-emulator-local-provider.md` (create)

**Out of scope**:

- Any change to `packages/core/src` (contracts belong to 010; report if one is needed).
- Running Voke bundles inside the emulator's Lambda. Revisit when its runtime gains
  `Request`/`Response` and the missing `node:` modules.
- A `voke dev` SQS poller delivering emulator queue messages to local Functions (follow-up).
- One emulator per test (`-p 0`) helpers in `@voke/testing` / `@voke/aws/testing`.
- An emulator-aware `createStackTestContext` (see open decision below; it stays Floci-shaped here).
- Native Linux binary management and attaching to an emulator the user started.
- Removing Floci.

## Git workflow

- Branch: `feature/aws-emulator-local-provider`
- Commit only if authorized; short imperative sentence-case messages.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Generalize the Local AWS Provider lifecycle

In `packages/aws/src/local-provider.ts`, reshape `LocalProvider` so it does not assume Docker Compose:

```ts
export interface LocalProviderLifecycleOptions {
  directory: string;   // absolute, <project>/.voke/local/<local provider name>
  options: Readonly<Record<string, string>>; // the `voke local` flags from ProviderLocalWorkflowContext
  region: string;
}

export interface LocalProvider {
  name: string;
  defaults: LocalProviderDefaults;
  files: (o: LocalProviderLifecycleOptions) => Record<string, string>; // path → contents, written before start
  startCommands: (o: LocalProviderLifecycleOptions) => string[][];
  stopCommands: (o: LocalProviderLifecycleOptions) => string[][];
  resetCommands: (o: LocalProviderLifecycleOptions) => string[][];
  waitUntilReady?: (o: LocalProviderLifecycleOptions) => Promise<void>;
  environment: (o: LocalAwsEnvironmentOptions) => LocalAwsEnvironment | Promise<LocalAwsEnvironment>;
  unsetEnvironment?: readonly string[];
  bootstrap: "cloudformation-cli" | "cloudformation-sdk";
  bootstrapPlan?: ...;   // kept for "cloudformation-cli" providers
  bindings: "outputs" | "guessed";
}
```

- Port `floci()` with identical commands and files: `files` returns the compose file at the
  `compose` option path (default `.voke/local/docker-compose.yml`), and the commands are the same
  `docker compose -f <file> up -d | down | down -v`. Floci uses `bootstrap: "cloudformation-cli"`
  and `bindings: "guessed"`.
- Loosen `LocalAwsEnvironment` to `Record<string, string> & { AWS_ENDPOINT_URL; AWS_REGION;
AWS_DEFAULT_REGION; VOKE_AWS_ENDPOINT_URL; VOKE_LOCAL_PROVIDER; VOKE_INVOKE_RUNTIME: "local" }`.
  The credential keys become Floci-only.
- Update `createLocalWorkflow` (from 010) to drive the generalized lifecycle: write `files`, run each
  command through `context.run` with `unsetEnv: provider.unsetEnvironment`, then `await waitUntilReady`.

### Step 2: The AWS Emulator Local AWS Provider

Create `packages/aws/src/local-aws-emulator.ts` exporting
`awsEmulator(options?: { port?: number; version?: string; telemetry?: boolean; memory?: string; image?: string }): LocalProvider`,
re-exported from `@voke/aws/local`.

- `files`:
  - `<directory>/Dockerfile` with the documented content, choosing `aarch64` when
    `process.arch === "arm64"`, else `x86_64`. Use `LTS/latest` unless `version` is set, then the
    pinned filename `aws-emulator-<version>-1-<arch>.rpm`.
  - `<directory>/config` containing only `[default]\nregion = <region>\n`, because the generated
    config holds a container path.
- `startCommands`:
  1. `docker build -q -t <image> <directory>`, where `<image>` defaults to
     `voke-aws-emulator:<version or "latest">-<arch>`. Skip the build when `docker image inspect <image>`
     succeeds, unless `voke local start --rebuild` is passed (`options.rebuild`).
  2. `docker run --rm -d --name voke-aws-emulator-<port> --memory=2g --memory-swap=2g -p 127.0.0.1:<port>:<port> -v <directory>:/home/emulator/.aws/emulator <image> -p <port> -t off`
     (`-t on` only when `telemetry: true`). On Linux add `--user <uid>:<gid>`.
- `waitUntilReady`: wait for `<directory>/<port>/ca.pem`, then poll
  `https://127.0.0.1:<port>/__admin/health` with that CA (`fetch(url, { tls: { ca } })`) until
  `200 ok`. Time out after 30 s with a `LocalProviderError` that suggests
  `docker logs voke-aws-emulator-<port>`. Inject the clock and fetch for unit tests.
- `stopCommands`: `docker stop voke-aws-emulator-<port>`. `resetCommands`: stop, then the run command
  again (state is in memory).
- `environment` (async): check that the port directory exists. If it does not, throw
  `LocalProviderError` "AWS Emulator is not running. Start it with `voke local start`." Otherwise return:
  ```
  AWS_ENDPOINT_URL=https://127.0.0.1:<port>      VOKE_AWS_ENDPOINT_URL=<same>
  AWS_SHARED_CREDENTIALS_FILE=<directory>/<port>/emulator_credentials
  AWS_CONFIG_FILE=<directory>/config
  AWS_CA_BUNDLE=<directory>/<port>/ca.pem         NODE_EXTRA_CA_CERTS=<same>
  AWS_EC2_METADATA_DISABLED=true                  AWS_DISABLE_HOST_PREFIX_INJECTION=true
  AWS_REGION / AWS_DEFAULT_REGION=<region>
  VOKE_LOCAL_PROVIDER=aws-emulator                VOKE_INVOKE_RUNTIME=local
  ```
- `unsetEnvironment`: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`.
- `defaults`: account `000000000000`, endpoint `https://127.0.0.1:9297`, region `us-east-1`.
- `bootstrap: "cloudformation-sdk"` when 004's seam exists, else `"cloudformation-cli"` (Step 4b).
  `bindings: "outputs"`.

### Step 3: Resources-only synthesis

Add an option to `synthesizeCloudFormationFromModel` in `packages/aws/src/cloudformation-synthesis.ts`
(for example `{ scope: "all" | "resources" }`, default `"all"`). With `"resources"` the template
contains only the declared resources (with their `Metadata.VokeBinding`) and the resource outputs. It
has no role, Lambda, API, routes, permissions, log groups, or event source mappings. Model validation
(`aws()` `validate`) still runs on the full model, so a bad `sqs({ queue })` reference fails locally too.

### Step 4: Local bootstrap writes outputs to a file

Common to both paths: deploy the resources-only template to stack `<name>-<stage>`, print one line
per resource, then write `.voke/local/outputs.json`:
`{ provider, endpoint, region, stack, bindings: { "<VOKE_RESOURCE_..._ATTR>": "<output value>" } }`.
Map each output back to its binding variable through `Metadata.VokeBinding` and
`createResourceBindingName`.

**4a: SDK path (when 004's seam exists in `@voke/aws`).** Let the CloudFormation client factory
take `{ endpoint, caFile, credentialsFile }`. Read the CA file and give the SDK clients an HTTPS
agent that trusts it. Load credentials from the shared credentials file through the SDK's ini
provider. Do not rely on `NODE_EXTRA_CA_CERTS` here, because the CLI process is already running.
Expose 004's stack routine so it accepts an inline `TemplateBody`; no artifact bucket is needed.

**4b: CLI fallback (allowed when 004 is not done).** Write the template to
`.voke/local/cloudformation.json` and run
`aws cloudformation deploy --stack-name <stack> --template-file <path> --region <region>` through
`context.run`, with the emulator environment (it includes `AWS_CA_BUNDLE`) and `unsetEnv`. This path
was tested and works, and it needs the AWS CLI. Then read outputs with
`aws cloudformation describe-stacks --stack-name <stack> --output json`. The core runner returns no
stdout, so capture this one command inside `@voke/aws` with `Bun.spawn` behind an injectable
`captureCommand` for tests, using the same env and unset rules. Record in the PR which path shipped.

Floci keeps its current `aws cloudformation deploy` of the full template and writes no outputs file.

### Step 5: `voke dev` uses real outputs

In the `aws()` `local.devEnvironment` (`packages/aws/src/index.ts`):

- Await the Local AWS Provider environment.
- If the provider has `bindings: "outputs"`, read `.voke/local/outputs.json`. Use its `bindings`
  only when its `provider`, `stack` and `endpoint` match the current config. Otherwise return no
  resource bindings, and print one line to stderr:
  `Local resources are not provisioned. Run: voke local start && voke local bootstrap`.
- For `bindings: "guessed"` (Floci), keep `createLocalResourceBindings`.
- Return `unsetEnvironment` from the provider so the `bun --hot` child gets the emulator environment
  (including `NODE_EXTRA_CA_CERTS`, which must be present at process start) and no real AWS credentials.
- `voke local stop` and `voke local reset` delete `.voke/local/outputs.json`, because emulator state is in memory.

### Step 6: Make the emulator the default and keep users safe

- `aws()` with no `local` option uses `awsEmulator()`. `aws({ local: floci() })` selects Floci.
- `createAwsClientConfig()` (`packages/aws/src/resources.ts`) already returns an explicit `endpoint`.
  Explain why in its doc comment and in the docs: SQS queue URLs carry the real AWS host, so a client
  without an explicit endpoint would call real AWS. Add a test that pins the explicit-endpoint behavior.
- `voke local start` prints the endpoint, the state directory, and the next command. It prints no keys.
- If 006 added a provider `diagnostics` capability, add an emulator check (Docker present, image
  built, port free) there.
- Update tests that assumed Floci as the default: core CLI/dev tests and `examples/e2e`. They now
  pass `floci()` explicitly or assert emulator commands.

### Step 7: Docs and ADR

- `docs/adr/<next free number>-aws-emulator-local-provider.md`: the six decisions and the test
  evidence above (emulator version, what worked, the Lambda runtime gap). Match the format of
  `docs/adr/0006-http-api-authorizers.md`.
- `apps/docs/content/docs/guides/local-aws.mdx` (add `guides/local-aws` to
  `apps/docs/content/docs/meta.json` under Guides). Cover:
  - start → bootstrap → dev → stop
  - what runs where: resources in the emulator, Functions in the local Gateway
  - the first start builds a 1.2 GB image
  - state is in memory
  - the telemetry setting
  - using Floci through `aws({ local: floci() })`
  - using `createAwsClientConfig()` for every AWS SDK client
- `README.md`: the "Local AWS" section (renamed by 010) covers both Local AWS Providers, with the emulator first.
- `docs/e2e-testing.md`: reading `.voke/local/outputs.json` in integration tests; note that
  `createStackTestContext` still targets Floci.

## Test plan

- `packages/aws/test/local.test.ts`:
  - Floci through the new interface: same commands, same compose file, same environment as before.
  - Emulator `files`: arch selection and the pinned version filename.
  - Emulator `startCommands`: loopback publish, memory flags, volume, `-t off`, `-t on` when opted
    in, build skipped when the image exists, `--rebuild`.
  - Emulator `stopCommands` and `resetCommands`.
  - `waitUntilReady`: success, and a timeout error naming `docker logs`, using a fake fetch and clock.
  - Emulator `environment`: all variables present, paths under the project directory, no
    `AWS_ACCESS_KEY_ID`. A missing state directory gives `LocalProviderError` with the start hint.
  - `unsetEnvironment` names, and the workflow passing `unsetEnv` to the runner.
  - `aws()` defaults to the emulator; `aws({ local: floci() })` gives Floci.
- Synthesis tests (`packages/aws/test`): `scope: "resources"` contains only declared resources and
  their outputs; an invalid queue reference still fails.
- Bootstrap, with fake clients (4a) or a fake runner and `captureCommand` (4b): the template is
  resources-only, outputs map to `VOKE_RESOURCE_*` names, `.voke/local/outputs.json` is written, and
  stop and reset remove it.
- `devEnvironment`: a matching outputs file gives bindings from the file. A missing or mismatched
  file gives no bindings plus the hint line. Floci is unchanged. `unsetEnvironment` is returned.
- `packages/aws/test/aws-emulator.e2e.test.ts` (gated by `VOKE_E2E_EMULATOR=1`; uses a non-default
  port and a temporary project directory):
  - start, then health returns ok
  - bootstrap a config with `dynamodbTable` and `sqsQueue`; the outputs file has a table name and a queue URL
  - a DynamoDB put/get and an SQS send/receive succeed through AWS SDK clients built from
    `createAwsClientConfig()`, in a child process started with the provider environment
  - stop removes the container and the outputs file
- Structural pattern: the Floci tests in `packages/aws/test/local.test.ts` (ported by 010).

## Done criteria

- [ ] `cd packages/aws && bun test` and `cd packages/core && bun test` → 0 fail without Docker and without network access
- [ ] `bun run typecheck` and `bun run check` exit 0
- [ ] `git diff --stat 3435023 -- packages/core/src` shows no changes made by this plan (contracts come from 010)
- [ ] With Docker and operator consent to download the AWS package: `VOKE_E2E_EMULATOR=1 bun test test/aws-emulator.e2e.test.ts` passes, or the step is reported as not run
- [ ] In `examples/hello-api` (config has `provider: aws()`): `voke local start`, `voke local bootstrap`, then `voke dev` starts with `VOKE_RESOURCE_USERS_TABLE_NAME` equal to the `UsersTableName` stack output (shown through a test or the dev plan, never by logging secrets)
- [ ] `grep -rn "emulator_credentials" packages/aws/src` shows only path construction, never a file read
- [ ] `docker ps --format '{{.Ports}}' --filter name=voke-aws-emulator` shows `127.0.0.1:` bindings only
- [ ] `aws({ local: floci() })` produces the same commands, compose file and environment as before (ported Floci tests unchanged in intent)
- [ ] The ADR and the local AWS guide exist; the README describes both Local AWS Providers
- [ ] The PR states which bootstrap path shipped (SDK or CLI fallback)
- [ ] No files outside the in-scope list are modified

## STOP conditions

- Plan 010 has not landed, or its contract lacks async `devEnvironment`, `unsetEnvironment`/`unsetEnv`,
  or `aws({ local })`. Do not add these to core here; report.
- The owner reverses the emulator-default decision. Stop before Step 6 and ship the emulator as
  opt-in (`aws({ local: awsEmulator() })`).
- Downloading and running the AWS package in Docker was not authorized for the e2e step. Finish the
  unit-tested work and report the e2e as not run.
- The emulator version current at execution behaves differently from 1.0.367 on a point this plan
  relies on: credentials files, health route, CloudFormation change sets for SQS, DynamoDB, S3, SNS,
  EventBridge, Secrets Manager or SSM, or generated outputs. Report the difference; pin `version` if
  an older release works.
- A declared Voke resource type fails to provision through the emulator's CloudFormation. Report the
  event reason verbatim; do not silently skip the resource.
- 004's seam exists but differs in shape from Step 4a's needs. Use 4b and report rather than reshaping 004's public API.

## Maintenance notes

- Re-test the Lambda runtime gap on new emulator releases. When a Voke bundle can load there, a full
  local deploy (004's pipeline against the emulator endpoint) becomes possible and is the natural next step.
- The image tag includes the emulator version, and `LTS/latest` images go stale. `voke local start --rebuild`
  refreshes them; consider printing the image age.
- If 4b shipped, switch to 4a once 004 lands, which drops the AWS CLI prerequisite.
- Follow-ups: a `voke dev` SQS poller using `functions.sendEvent`, an emulator-aware
  `createStackTestContext` (async, outputs-based), per-test emulators on port 0, and native Linux binary support for CI.
- Reviewers should check that no code path reads or prints the generated keys, that child processes
  cannot see real AWS credentials, that the port is published on loopback only, and the
  outputs-file staleness check.

## Execution notes (2026-11-14)

Done except the real-emulator e2e, on branch `feature/aws-emulator-local-provider` (PR #59), stacked on plan 006
(`feature/first-run-experience`, PR #58, open). Gates: `bun run check` 0 errors,
`bun run typecheck` 18/18, `bun run test` 23/23 tasks (`@voke/aws` 99, core 243), all without Docker or
network. `packages/core/src` is unchanged.

- **Lifecycle:** `LocalProvider` now uses `files`, `prepareStart`, `startCommands`/`stopCommands`/
  `resetCommands`, `waitUntilReady`, an async `environment`, `unsetEnvironment`, `flags`, and
  `bindings: "outputs" | "guessed"`. `floci()` returns `FlociLocalProvider` (with `composeConfig` and a
  synchronous `environment`). The ported Floci tests keep their commands, compose file and environment.
  The only changes are Floci's failure hint, which no longer calls it the default, and
  `unsetEnv: []` on its runner calls.
- **`awsEmulator()`** (`local-aws-emulator.ts`):
  - Writes the AWS Dockerfile (arch-specific RPM) and a host-usable `config` into
    `.voke/local/aws-emulator/`.
  - Builds the image only when `docker image inspect` fails or `--rebuild` is passed.
  - Runs `docker run` on `127.0.0.1:<port>` with `--memory=2g`, the state volume and `-t off`.
  - Waits for `ca.pem` and `/__admin/health`, with a 30 s timeout that suggests `docker logs`.
  - Its environment passes the credentials, config and CA files by path and unsets the real AWS
    credential variables.
- **Resources-only synthesis:** `synthesizeCloudFormationFromModel(model, { scope: "resources" })`.
  `resourceOutputBindings(model)` maps stack outputs to `VOKE_RESOURCE_*` names.
- **Bootstrap, CLI fallback (Step 4b):**
  - Shipped path: `aws cloudformation deploy --no-fail-on-empty-changeset` of the resources-only
    template, then `describe-stacks` captured through an injectable `capture` (Node `child_process`,
    with the same env and unset rules). The result is written to `.voke/local/outputs.json`.
  - Why 4b: 004's SDK client has no option for the emulator's per-run CA or credentials file, and
    adding one would need new SDK dependencies or a reshaped 004 API.
  - `stop` and `reset` delete the outputs file.
- **`voke dev`:** with the emulator, `aws().local.devEnvironment` awaits the environment, binds from the
  outputs file only when provider, stack and endpoint match (otherwise it prints the
  `voke local start && voke local bootstrap` hint to stderr), and returns `unsetEnvironment`. Floci
  keeps derived names.
- **Default:** `aws()` uses `awsEmulator()`. `aws({ local: floci() })` selects Floci.
- **`createAwsClientConfig()`:** its doc comment explains why the explicit endpoint matters, and a test
  pins it.
- **Docs:** ADR `docs/adr/0009-aws-emulator-local-provider.md`, the guide `guides/local-aws.mdx` (added to
  `meta.json`), the README Local AWS section (emulator first, Floci second), and `docs/e2e-testing.md`.

Adaptations and deviations:

- New test files `local-aws-emulator.test.ts` and `resources-only-synthesis.test.ts` (instead of growing
  `local.test.ts`).
- Files outside the listed scope:
  - `packages/aws/src/diagnostics.ts` reads the tool name from `startCommands`.
  - `packages/aws/src/testing.ts` throws a clear `TypeError` for a Local AWS Provider with an async
    environment; `createStackTestContext` stays Floci-shaped.
  - `packages/core/test/config-typecheck.ts` and the custom `LocalProvider` fixtures in core tests use
    the new interface.
  - `apps/docs/content/docs/reference/cli.mdx` no longer says Floci is the default.
- `voke local start` prints the endpoint, state directory and next command for the emulator through an
  injectable output in `createLocalWorkflow`. Core's workflow context has no output seam, and adding
  one would be a core change.
- **Gated e2e:** `aws-emulator.e2e.test.ts` provisions a table, a queue and a bucket and checks their
  outputs. Its data-plane check uses S3 (`@aws-sdk/client-s3` is already a dependency) instead of
  DynamoDB/SQS, whose clients `@voke/aws` does not depend on.
- **Unverified:** the pinned-version download path assumes `LTS/<version>/aws-emulator-<version>-1-<arch>.rpm`.
  The plan gives only the file name.

Not run:

- **Real emulator:** `VOKE_E2E_EMULATOR=1 bun test test/aws-emulator.e2e.test.ts` and the
  `examples/hello-api` start → bootstrap → dev check were not run. They need Docker and a download of the
  AWS Emulator package (a 1.2 GB image), which was not authorized. A unit test with a fake outputs file
  covers the dev binding.
- **`docker ps` loopback check:** not run. The `docker run` arguments publish on `127.0.0.1` only, and a
  test asserts it.
