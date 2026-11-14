# Plan 007: `voke local` and `voke dev` run against the official AWS Emulator with real stack outputs

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/src/local.ts packages/core/src/local-provider.ts packages/core/src/dev.ts packages/core/src/cli.ts packages/core/src/config.ts packages/core/src/cloudformation.ts packages/core/test README.md apps/docs/content docs`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `.factory/plans/004-one-command-deploy.md` (reuses its CloudFormation client seam and stack-deploy routine). Lands after 006 if both touch `cli.ts` at the same time.
- **Category**: dx
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

AWS released an official local emulator on 2026-11-11. It answers AWS API calls with AWS's own
validation and errors, starts in seconds, and its CloudFormation can provision the resources a
Voke project declares. Using it gives Voke developers a local loop that behaves like the cloud:
real resource names, real queue URLs, and deploy-time mistakes caught on a laptop. Today Voke's
local mode guesses resource identifiers and hands out fixed dummy credentials, neither of which
works with this emulator.

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
  the HTTP API route (send the request to the emulator endpoint with
  `Host: <apiId>.execute-api.us-east-1.amazonaws.com`), the SQS trigger, and CloudWatch Logs
  (`aws logs tail`) all worked for a small hand-written handler.

**What did not work**

- **A Voke bundle cannot run inside the emulator's Lambda.** Its JavaScript runtime is not
  Node.js: it reports `node 22.0.0` but has no `fetch`, `Request`, `Response`, `Headers`,
  `ReadableStream`, or `structuredClone`, and no `node:module`, `node:http`, `node:https`,
  `node:zlib`, `node:async_hooks`. The Voke Gateway is built on Hono, which needs
  `Request`/`Response`. The Node-target bundle failed at import with
  `Runtime.ImportModuleError: Cannot find module 'node:module'`. (`@aws-sdk/client-*` is importable there.)
- **Queue URLs point at the real AWS host.** With only `AWS_ENDPOINT_URL` in the environment, the
  JavaScript SDK's SQS client used the QueueUrl host and sent the request to
  `sqs.us-east-1.amazonaws.com` (rejected with `InvalidClientTokenId`). With an explicit
  `endpoint` in the client constructor, send and receive went to the emulator. Voke's
  `createAwsClientConfig()` (`packages/core/src/aws.ts:51-66`) returns an explicit `endpoint` when
  `VOKE_AWS_ENDPOINT_URL` or `AWS_ENDPOINT_URL` is set, so clients built from it are safe.
- An emulator-side event source mapping delivers queue messages to the emulator's Lambda and
  deletes them. With a placeholder function there, messages would vanish.

**Consequence for the design**: use the emulator for resources and the control plane. Keep
running Function code in the local Gateway (`voke dev`, real Bun), which is Voke's existing local
model. Do not deploy Lambdas, APIs, or event source mappings to the emulator.

## Current state in Voke

- Provider interface, `packages/core/src/local-provider.ts:67-80`:
  ```ts
  export interface LocalProvider {
    name: string;
    defaults: LocalProviderDefaults;
    bootstrapPlan: (
      options
    ) => LocalBootstrapPlan | Promise<LocalBootstrapPlan>;
    composeConfig: (options?) => string;
    environment: (options?) => LocalAwsEnvironment;
    resetCommand: (options: LocalProviderCommandOptions) => string[];
    startCommand: (options: LocalProviderCommandOptions) => string[];
    stopCommand: (options: LocalProviderCommandOptions) => string[];
  }
  export type LocalProviderInput = "floci" | LocalProvider;
  ```
  It assumes a Docker Compose file (`composeConfig`, `composePath`) and a synchronous environment.
- `LocalAwsEnvironment` (`local-provider.ts:3-13`) requires `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` as strings; Floci fills them with `test`
  (`local-provider.ts:154-178`).
- The only provider is Floci (`createFlociLocalProvider`, `local-provider.ts:106-203`): HTTP on
  port 4566, `docker compose -f <file> up -d|down|down -v`, bootstrap through
  `aws cloudformation deploy` with the full template.
- `voke local start|stop|reset|bootstrap` in `packages/core/src/cli.ts:578-651` writes the compose
  file and runs provider commands through `runLocalProviderCommand` (`cli.ts:282-304`).
- `runCommand` (`cli.ts:222-249`) builds the child environment as `{ ...Bun.env, ...options.env }`.
  There is no way to remove a variable, so real `AWS_PROFILE`/`AWS_ACCESS_KEY_ID` leak into children.
- `voke dev` (`packages/core/src/dev.ts:58-103`) synthesizes the template in memory and derives
  bindings with `createLocalResourceBindings(template, ...)`.
- Guessed bindings, `packages/core/src/local.ts:100-154`: table name = logical id, queue URL =
  `${endpoint}/${accountId}/${logicalId}`, topic ARN built from the logical id, and so on. These
  never match CloudFormation-generated names, on this emulator or on AWS.
- Stack outputs already exist per resource (`packages/core/src/model.ts:444-455`,
  `cloudformation.ts:599-648`): `<LogicalId><OutputName>`, e.g. `UsersTableName`, `EventsQueueUrl`.
  Each resource has `Metadata.VokeBinding = { Attribute, Resource }` (`cloudformation.ts:664-673`).
- Config: `local: { provider, providerOptional }` (`packages/core/src/config.ts:56-64,150-153`),
  default `floci` via `resolveLocalProvider` (`local-provider.ts:205-213`).
- Tests: `packages/core/test/local.test.ts` (provider, environment, bootstrap, bindings),
  `test/dev.test.ts`, CLI local commands in `test/api.test.ts`/`test/cli-contract.test.ts`,
  including "runs CLI local commands through a configured custom provider".
- After plan 004: `packages/core/src/aws-deploy-clients.ts` (narrow `DeployAwsClients` interface
  with change-set, events, and describe-stack calls) and `packages/core/src/deploy.ts`.
- `voke/local` is a stable subpath (`docs/stable-public-surface.md`). The package is unpublished
  (version `0.0.0`), so the provider interface can change if tests and docs change with it.
- README section "Local AWS With Floci" and `docs/e2e-testing.md` describe the Floci flow.

## Decisions taken in this plan

1. **Resources on the emulator, code in the local Gateway.** Local bootstrap deploys a
   resources-only template. No Lambda, API Gateway, or event source mapping is created locally.
2. **AWS Emulator is the one built-in default** (ADR `docs/adr/0007-opinionated-framework.md`:
   "the AWS Emulator for local resources with Function code running in the local Gateway"; the
   `LocalProvider` interface is the local layer's escape hatch). Floci stays available through
   that interface, `local: { provider: createFlociLocalProvider() }`, for projects that need
   persistent local state. The `"floci"` string shorthand is removed; there are no provider
   name strings. Nothing is
   published yet, so no user is migrated. The owner may veto the default; see STOP conditions.
3. **Bindings come from stack outputs**, written to `.voke/local/outputs.json` by bootstrap and
   read by `voke dev`. The guessing code remains only as the Floci fallback.
4. **Project-local state**: emulator files live in `.voke/local/aws-emulator/<port>/`, not in
   `~/.aws`. Voke never copies or prints the generated keys; it passes file paths.
5. **Telemetry off by default** for emulators that Voke starts (`-t off`), with
   `awsEmulator({ telemetry: true })` to opt in. Voke starts the process on the user's behalf, so
   the conservative setting is the default.
6. **Docker on every platform in v1.** A native Linux binary and externally managed emulators
   are follow-ups.

## Commands you will need

| Purpose                                                | Command                                                                          | Expected on success |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------- |
| Install                                                | `bun install`                                                                    | exit 0              |
| Core tests                                             | `cd packages/core && bun test`                                                   | all pass            |
| One test file                                          | `cd packages/core && bun test test/local.test.ts`                                | all pass            |
| Core typecheck                                         | `cd packages/core && bun run typecheck`                                          | exit 0              |
| Repo gates                                             | `bun run typecheck && bun run test`                                              | exit 0              |
| Lint/format                                            | `bun run check`                                                                  | exit 0              |
| Emulator e2e (needs Docker, downloads the AWS package) | `cd packages/core && VOKE_E2E_EMULATOR=1 bun test test/aws-emulator.e2e.test.ts` | all pass            |

## Implementation rules relevant to this plan

- Test first. Unit tests use the injected `CommandRunner` and fake clients; they must not start
  Docker or use the network. The real-emulator test is gated behind `VOKE_E2E_EMULATOR=1`.
- Never read, log, or print the contents of `emulator_credentials`. Pass its path through
  `AWS_SHARED_CREDENTIALS_FILE`.
- Child processes for the emulator provider must not inherit real AWS credentials or profiles.
- Publish the container port on `127.0.0.1` only.
- CLI-time modules may use Bun APIs; runtime modules must not (plan 002). Use `node:path` and
  `node:fs/promises` for paths and directories.
- Errors: `LocalProviderError` for provider command failures (existing class,
  `local-provider.ts:82-99`), with a message that names the failing command and the next step.
- No new dependencies beyond what plan 004 added.
- Keep Floci behavior unchanged, verified by the existing Floci tests.

## Scope

**In scope**:

- `packages/core/src/local-provider.ts`, `packages/core/src/local-aws-emulator.ts` (create), `packages/core/src/local.ts`, `packages/core/src/dev.ts`, `packages/core/src/config.ts` (default provider), `packages/core/src/cli.ts` (`local` command, `runCommand` env removal)
- `packages/core/src/cloudformation.ts` (resources-only synthesis option), `packages/core/src/deploy.ts` and `aws-deploy-clients.ts` (inline-template stack deploy and custom CA/credentials options)
- `packages/core/test/local.test.ts`, `test/dev.test.ts`, `test/cli-contract.test.ts`, `test/api.test.ts` (local CLI cases), `test/cloudformation.test.ts`, `test/aws-emulator.e2e.test.ts` (create)
- `examples/hello-api/src/local.ts`, `examples/e2e/test/local-floci.e2e.test.ts` (rename or add an emulator variant)
- `README.md` ("Local AWS" section), `apps/docs/content/docs/guides/local-aws.mdx` (create) and `meta.json`, `docs/e2e-testing.md`, `docs/adr/0009-aws-emulator-local-provider.md` (create)
- `.factory/plans/README.md` (status only)

**Out of scope**:

- Running Voke bundles inside the emulator's Lambda. Revisit when its runtime gains
  `Request`/`Response` and the missing `node:` modules.
- Delivering SQS messages to local Functions automatically (a `voke dev` queue poller). Tests
  keep using `functions.sendEvent(...)`. Listed as a follow-up in the plans index.
- One emulator per test (`-p 0`) helpers in `voke/testing`.
- Native Linux binary management and attaching to an emulator the user started.
- Removing Floci.

## Git workflow

- Branch: `feature/aws-emulator-local-provider`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Generalize the provider lifecycle

Reshape `LocalProvider` so it does not assume Docker Compose:

```ts
export interface LocalProviderLifecycleOptions {
  directory: string;   // absolute, e.g. <project>/.voke/local/<provider name>
  port?: number;
  region?: string;
}

export interface LocalProvider {
  name: string;
  defaults: LocalProviderDefaults;
  files: (options: LocalProviderLifecycleOptions) => Record<string, string>; // path → contents, written before start
  startCommands: (options: LocalProviderLifecycleOptions) => string[][];
  stopCommands: (options: LocalProviderLifecycleOptions) => string[][];
  resetCommands: (options: LocalProviderLifecycleOptions) => string[][];
  waitUntilReady?: (options: LocalProviderLifecycleOptions) => Promise<void>;
  environment: (options?: LocalAwsEnvironmentOptions) => LocalAwsEnvironment | Promise<LocalAwsEnvironment>;
  unsetEnvironment?: readonly string[];   // removed from child process environments
  bootstrap: "cloudformation-cli" | "cloudformation-sdk";
  bootstrapPlan: ...                        // kept for "cloudformation-cli" providers
}
```

- Port Floci to it with identical commands and files (`files` returns the compose file; the
  `--compose` flag keeps working as the file path override).
- Loosen `LocalAwsEnvironment` to
  `Record<string, string> & { AWS_ENDPOINT_URL; AWS_REGION; AWS_DEFAULT_REGION; VOKE_AWS_ENDPOINT_URL; VOKE_LOCAL_PROVIDER; VOKE_INVOKE_RUNTIME: "local" }`.
- `runCommand` and `CommandRunOptions` gain `unsetEnv?: readonly string[]`; the child
  environment is built by copying `process.env`, deleting those names, then applying `env`.
- `LocalProviderInput` becomes `LocalProvider` (an object). `local.provider` omitted means the
  AWS Emulator provider with default options; `"floci"` as a string is rejected by `defineConfig`
  with `VokeConfigError.validation` at path `local.provider` and the message
  `pass a provider object: createFlociLocalProvider() from "voke/local"`.

### Step 2: The AWS Emulator provider

Create `packages/core/src/local-aws-emulator.ts` exporting
`createAwsEmulatorLocalProvider(options?: { port?: number; version?: string; telemetry?: boolean; memory?: string; image?: string })`,
re-exported from `voke/local` as `awsEmulator`.

- `files`: `<directory>/Dockerfile` with the documented content, choosing `aarch64` when
  `process.arch === "arm64"`, else `x86_64`; `LTS/latest` unless `version` is set, then the pinned
  filename `aws-emulator-<version>-1-<arch>.rpm`. Also `<directory>/config` containing only
  `[default]\nregion = <region>\n` (the generated config holds a container path).
- `startCommands`:
  1. `docker build -q -t <image> <directory>` where `<image>` defaults to
     `voke-aws-emulator:<version or "latest">-<arch>`. Skip the build when
     `docker image inspect <image>` succeeds, unless `voke local start --rebuild` is passed.
  2. `docker run --rm -d --name voke-aws-emulator-<port> --memory=2g --memory-swap=2g -p 127.0.0.1:<port>:<port> -v <directory>:/home/emulator/.aws/emulator <image> -p <port> -t off`
     (`-t on` only when `telemetry: true`). On Linux add `--user <uid>:<gid>`.
- `waitUntilReady`: wait for `<directory>/<port>/ca.pem`, then poll
  `https://127.0.0.1:<port>/__admin/health` with that CA (`fetch(url, { tls: { ca } })`) until
  `200 ok`; time out after 30 s with a `LocalProviderError` that suggests `docker logs voke-aws-emulator-<port>`.
- `stopCommands`: `docker stop voke-aws-emulator-<port>`. `resetCommands`: stop, then the run
  command again (state is in memory).
- `environment` (async): verify the port directory exists, else throw
  `LocalProviderError` "AWS Emulator is not running. Start it with `voke local start`." Return:
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
- `bootstrap: "cloudformation-sdk"`.

### Step 3: Resources-only synthesis

Add an option to `synthesizeCloudFormation` (for example `scope: "all" | "resources"`). With
`"resources"` the template contains only the resources declared in config (with their
`Metadata.VokeBinding`) and their outputs: no role, Lambda, API, routes, permissions, log groups,
or event source mappings. Model validation still runs on the full model, so a bad
`sqs({ queue })` reference fails locally too.

### Step 4: Local bootstrap through the SDK, outputs to a file

- In `aws-deploy-clients.ts`, let the default client factory take
  `{ endpoint, caFile, credentialsFile }`: read the CA file and give the SDK clients an HTTPS agent
  that trusts it; load credentials from the shared credentials file through the SDK's ini
  provider. Do not rely on `NODE_EXTRA_CA_CERTS` here: the CLI process is already running.
- In `deploy.ts`, expose the stack routine from plan 004 (change set → execute → follow events →
  outputs) as a function that accepts an inline `TemplateBody`, so no artifact bucket is needed.
- `voke local bootstrap` for a `"cloudformation-sdk"` provider: synthesize the resources-only
  template, deploy it to stack `<name>-<stage>`, print one line per resource, then write
  `.voke/local/outputs.json`:
  `{ provider, endpoint, region, stack, bindings: { "<VOKE_RESOURCE_..._ATTR>": "<output value>" } }`.
  Map each output back to its binding variable through `Metadata.VokeBinding` and
  `createResourceBindingName` (`packages/core/src/bindings.ts`).
- `"cloudformation-cli"` providers (Floci) keep the current `aws cloudformation deploy` path.

### Step 5: `voke dev` uses real outputs

In `createDevPlan` (`dev.ts`):

- Resolve the provider environment with `await`.
- If `.voke/local/outputs.json` exists and its `provider`, `stack`, and `endpoint` match the
  current config, use its `bindings`. Otherwise, for `aws-emulator`, do not guess: leave bindings
  unset and print one line: `Local resources are not provisioned. Run: voke local start && voke local bootstrap`.
  For Floci keep `createLocalResourceBindings`.
- Add `unsetEnv` to the dev plan and pass it to the runner, so the `bun --hot` child gets the
  emulator environment (including `NODE_EXTRA_CA_CERTS`, which must be present at process start)
  and no real AWS credentials.
- Because emulator state is in memory, `voke local stop` and `voke local reset` delete
  `.voke/local/outputs.json`.

### Step 6: Make it the default and keep users safe

- `resolveLocalProvider()` with no argument returns the AWS Emulator provider; with a provider
  object it returns that object.
- `createAwsClientConfig()` already returns an explicit `endpoint`. Add to its doc comment and
  to the docs why that matters (SQS queue URLs carry the real AWS host; a client without an
  explicit endpoint would call real AWS). Add a test that pins the explicit-endpoint behavior.
- `voke local start` prints the endpoint, the state directory, and the next command. It prints
  no keys.
- If plan 006's `voke doctor` exists, extend its Docker check message to name the emulator.

### Step 7: Docs and ADR

- `docs/adr/0009-aws-emulator-local-provider.md`: the six decisions and the test evidence above
  (emulator version, what worked, the Lambda runtime gap). Match the format of
  `docs/adr/0006-http-api-authorizers.md`.
- `apps/docs/content/docs/guides/local-aws.mdx`: start → bootstrap → dev → stop; what runs where
  (resources in the emulator, Functions in the local Gateway); first start builds a 1.2 GB image;
  state is in memory; telemetry setting; using Floci through `createFlociLocalProvider()`; using `createAwsClientConfig()` for
  every AWS SDK client.
- `README.md`: replace "Local AWS With Floci" with "Local AWS" covering both providers.
- `docs/e2e-testing.md`: reading `.voke/local/outputs.json` in integration tests.

## Test plan

- `test/local.test.ts`:
  - Floci through the new interface: same commands, same compose file, same environment as today
  - emulator `files` (arch selection, pinned version filename), `startCommands` (loopback publish,
    memory flags, volume, `-t off`, `-t on` when opted in), `stopCommands`, `resetCommands`
  - emulator `environment`: all variables present, paths under the project directory, no
    `AWS_ACCESS_KEY_ID`; missing state directory → `LocalProviderError` with the start hint
  - `unsetEnvironment` names
- `test/cli-contract.test.ts`: `runCommand`-level env removal (a variable in `unsetEnv` is absent
  from the child environment, asserted through the injected runner's received options);
  `voke local start|stop|reset|bootstrap` command sequences for both providers; `--rebuild`.
- `test/cloudformation.test.ts`: `scope: "resources"` contains only declared resources and their
  outputs; an invalid queue reference still fails.
- Bootstrap with a fake `DeployAwsClients`: inline template body, outputs mapped to
  `VOKE_RESOURCE_*` names, `.voke/local/outputs.json` written; stop and reset remove it.
- `test/dev.test.ts`: outputs file present and matching → bindings from the file; missing →
  no guessed bindings and the hint line for the emulator; Floci unchanged; `unsetEnv` in the plan.
- `test/aws-emulator.e2e.test.ts` (gated by `VOKE_E2E_EMULATOR=1`, uses a non-default port and a
  temporary project directory): start, health ok, bootstrap a config with `dynamodbTable` and
  `sqsQueue`, outputs file has a table name and a queue URL, a DynamoDB put/get and an SQS
  send/receive succeed through AWS SDK clients built from `createAwsClientConfig()` in a child
  process started with the provider environment, stop removes the container and the outputs file.
- Structural pattern: existing provider tests in `packages/core/test/local.test.ts`.

## Done criteria

- [ ] `cd packages/core && bun test` → 0 fail without Docker and without network access
- [ ] `bun run typecheck` and `bun run check` exit 0
- [ ] With Docker available and operator consent to download the AWS package: `VOKE_E2E_EMULATOR=1 bun test test/aws-emulator.e2e.test.ts` passes, or the step is reported as not run
- [ ] In `examples/hello-api`: `voke local start`, `voke local bootstrap`, then `voke dev` starts with `VOKE_RESOURCE_USERS_TABLE_NAME` equal to the `UsersTableName` stack output (visible through a test or a debug print of the dev plan, not by logging secrets)
- [ ] `grep -rn "emulator_credentials" packages/core/src` shows only path construction, never a file read
- [ ] `docker ps --format '{{.Ports}}' --filter name=voke-aws-emulator` shows `127.0.0.1:` bindings only
- [ ] A project with `local: { provider: createFlociLocalProvider() }` gets the same commands, compose file, and environment Floci produced before (existing Floci tests ported, unchanged in intent)
- [ ] ADR 0009 and the local AWS guide exist; README describes both providers
- [ ] No files outside the in-scope list are modified

## STOP conditions

- The owner does not want AWS Emulator as the default provider. Stop before step 6 and report;
  under ADR 0007 there is one default, so the alternative is to keep Floci as the default and
  offer the emulator through `local: { provider: awsEmulator() }`.
- Downloading and running the AWS package in Docker was not authorized for the e2e step. Finish
  the unit-tested work and report the e2e as not run.
- The emulator version current at execution time behaves differently from 1.0.367 on a point
  this plan relies on (credentials files, health route, CloudFormation change sets for SQS,
  DynamoDB, S3, SNS, EventBridge, Secrets Manager, SSM, or generated outputs). Report the
  difference; pin `version` if an older release works.
- A declared Voke resource type fails to provision through the emulator's CloudFormation. Report
  the event reason verbatim; do not silently skip the resource.
- Plan 004's `deploy.ts`/`aws-deploy-clients.ts` do not exist or differ in shape. Reconcile
  before step 4; the fallback for this plan is the `"cloudformation-cli"` path with
  `AWS_CA_BUNDLE`, which was tested and works but keeps the AWS CLI as a prerequisite.

## Maintenance notes

- Re-test the Lambda runtime gap on new emulator releases. When a Voke bundle can load there,
  a full local deploy (plan 004 pipeline against the emulator endpoint) becomes possible and is
  the natural next step.
- The image tag includes the emulator version; `LTS/latest` images go stale. `voke local start --rebuild`
  refreshes; consider printing the image age.
- Follow-ups enabled by this plan: a `voke dev` SQS poller that delivers emulator queue messages
  through `functions.sendEvent`, per-test emulators on port 0 in `voke/testing`, native Linux
  binary support for CI.
- Reviewers should scrutinize: that no code path reads or prints the generated keys, that child
  processes cannot see real AWS credentials, the loopback-only port publish, and the
  outputs-file staleness check.
