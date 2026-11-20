# Plan 031: Remote Function Registries have one implementation, in `@voke/remote`, and a failed remote call always rejects with an `InvokeError`

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/remote packages/http packages/core/src/remote.ts packages/core/src/index.ts packages/core/src/response.ts packages/core/test/remote-functions.test.ts packages/core/test/public-surface.test.ts apps/docs/content/docs/guides/remote-functions.mdx apps/docs/content/docs/reference docs CONTEXT.md`
> and `git status --short` with the recorded current state. Plans 022–030 run first. Expected
> drift: plan 022 may add `packages/remote/bunfig.toml` and a test preload; plan 023 changes
> error mapping in `packages/core/src/app.ts`; plan 024 changes types in
> `packages/core/src/invoke.ts`; plan 026 changes `voke remote generate` argument handling in
> `packages/core/src/cli.ts`. None of them should have changed `packages/core/src/remote.ts` or
> `packages/remote/src/index.ts`. Reconcile routine drift; pause if `InvokeOptions`,
> `InvokeError` or `InvokeErrorCode` no longer have the members quoted below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (hard). Ordering only: after `.factory/plans/022-root-test-run.md`
  (test setup in `packages/remote`), `.factory/plans/023-http-request-edge.md` (it leaves the
  Dev Function Invoke Endpoint's error bodies to this plan), `.factory/plans/024-schema-helper-types.md`
  (`invoke.ts` types) and `.factory/plans/026-cli-argument-and-cwd-correctness.md` (`cli.ts`).
- **Category**: tech-debt, bug
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

The code for calling another Voke Project exists twice: `packages/core/src/remote.ts` (739
lines) and `packages/remote/src/index.ts` (656 lines). Core's tests exercise core's copy of
`createRemoteFunctions`, which no user can import; the copy users do import, through the
modules that `voke remote generate` writes, has no test. That untested copy accepts
`timeoutMs`, `retries` and `mode` and ignores all three, and it rejects with a raw
`SyntaxError` or `TypeError` when the other project answers with something that is not JSON
or cannot be reached. After this plan each piece exists once, the client lives in
`@voke/remote` with its tests, and every failed call rejects with an `InvokeError` whose
`code` a caller can branch on.

## Current state

### Architecture rules (binding)

- `docs/adr/0007-specialized-provider-and-helper-packages.md`: "Specialized non-provider
  helpers belong to packages such as `@voke/schema`, `@voke/http`, `@voke/testing`,
  `@voke/remote`, and `@voke/build`". Core (`voke`) must not import `@voke/*`.
  `packages/core/tsconfig.json:6-8` gives the reason: "Core tests exercise the split
  @voke/\* packages, which depend on core. Declaring them as dependencies would create a
  workspace cycle, so tests resolve them from source instead (Bun honors these paths at
  runtime)." Core **tests** may therefore import `@voke/remote`; core **source** may not.
- `docs/adr/0007-opinionated-framework.md`: one supported way per layer, one name per API,
  and "Because the package is unreleased, removals happen without deprecation aliases".
- `docs/adr/0004-contract-metadata-remote-functions.md`: generated modules "export
  ready-to-import Remote Function Registries created with `createRemoteFunctions`"; "The
  first implementation slice is local `voke dev` to local `voke dev` invocation"; deployed
  cross-project invocation is deferred.
- `docs/stable-public-surface.md:24`: "Remote helpers: use `@voke/remote`". Line 27 lists
  `toContractJsonSchema` as "shared by `@voke/openapi` and `@voke/remote`".
  `packages/core/test/public-surface.test.ts` pins every package's runtime exports.
- Vocabulary (`CONTEXT.md`): **Remote Function Registry** (the typed catalog a consuming
  Voke Project calls), **Function Contract Artifact** (the metadata a provider project
  serves), **Remote Code Generation** (`voke remote generate`), **Dev Function Invoke
  Endpoint**, **Remote Helper**. Use "provider project" and "consuming project" for the two
  sides; **Provider** alone means the cloud Provider (`aws()`).

### Code at `1c59d39`

Measured with `diff packages/core/src/remote.ts packages/remote/src/index.ts`: 161 differing
lines. All but five differences are imports. The five:

| Difference             | Core copy                                 | `@voke/remote` copy                                   |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `toContractJsonSchema` | defined here (`remote.ts:242-297`)        | imported from `voke`                                  |
| fingerprint hash       | `sha256Hex` from `./runtime-env` (`:193`) | `createHash` from `node:crypto` (same digest)         |
| `toEnvKey`             | `./env-key`                               | private copy (`index.ts:26-31`)                       |
| reading the origin     | `readEnv(...)` (`:457`)                   | `process.env[...]` (`:368`)                           |
| endpoint responses     | `json` / `jsonError` from `./http`        | `ok` / `error` from `@voke/http`, with explicit codes |

Who calls which copy (every caller, found with `grep -rn` over `packages`, `examples`,
`apps/docs`, `docs`):

| Symbol                                                        | Core copy is called by                                                          | `@voke/remote` copy is called by                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineRemoteConfig`                                          | `packages/core/src/config.ts:17,330`                                            | nobody                                                                                                                                                                                                        |
| `remoteEnvironment`                                           | `packages/core/src/dev.ts:6,131`                                                | nobody                                                                                                                                                                                                        |
| `generateRemoteModules`, `renderRemoteModule`                 | `packages/core/src/cli.ts:32,621` (`voke remote generate`)                      | nobody                                                                                                                                                                                                        |
| `createFunctionContractArtifact`, `mountDevFunctionEndpoints` | `packages/core/src/app.ts:27,258` (the Gateway, when `VOKE_DEV_SUMMARY` is `1`) | only `packages/remote/test/dev-endpoints.test.ts`                                                                                                                                                             |
| `toContractJsonSchema`                                        | `packages/core/src/index.ts:133-134` (root export, for the other copy)          | its own `createFunctionContractArtifact`                                                                                                                                                                      |
| `createRemoteFunctions`                                       | only `packages/core/test/remote-functions.test.ts:15-20`                        | every generated module (`renderRemoteModule` writes `import { createRemoteFunctions } from "@voke/remote";`, `remote.ts:624`) and the docs sample in `apps/docs/content/docs/guides/remote-functions.mdx:149` |

So each copy is half dead. Core's `config.ts`, `dev.ts`, `cli.ts` and `app.ts` need the
project side synchronously and cannot import `@voke/remote`; the client is needed only by
generated modules, which import `@voke/remote`. `@voke/openapi` uses `readJsonSchema` only
(`packages/openapi/src/document.ts:3`), so after the cut no package needs
`toContractJsonSchema` from the root.

The client, identical in both copies (`packages/remote/src/index.ts:397-443`):

```ts
    value: async (
      functionName: string,
      payload?: unknown,
      options: InvokeOptions = {}
    ): Promise<unknown> => {
      // ... MISSING_FUNCTION and INVALID_PAYLOAD checks ...
      const response = await fetch(invokeUrl(project, functionName), {
        body: JSON.stringify({
          contractFingerprint: artifact.fingerprint,
          payload,
          trace: options.trace,
        } satisfies RemoteInvokeRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as
        | { data: unknown }
        | { error: { message: string } };

      if (!response.ok) {
        const message =
          "error" in body
            ? body.error.message
            : `Remote Function invocation failed with HTTP ${response.status}`;

        throw new InvokeError(message, {
          code:
            response.status === 404 ? "MISSING_FUNCTION" : "TRANSPORT_FAILED",
```

`options` is read once, for `options.trace`. A probe at `1c59d39` against the
`@voke/remote` copy, with `globalThis.fetch` stubbed, gave:

| Situation                                                          | Result today                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 502 with an HTML body                                              | rejects `SyntaxError: JSON Parse error: Unrecognized token '<'`                |
| 200 with an empty body                                             | rejects `SyntaxError: Unexpected end of JSON input`                            |
| 200 with body `null`; 500 with body `"oops"`                       | rejects `TypeError: body is not an Object`                                     |
| 500 with body `{"error":"plain"}`                                  | rejects `InvokeError` `TRANSPORT_FAILED` with an **empty** message             |
| `fetch` rejects; nothing listens on the origin                     | rejects the raw `TypeError` (`fetch failed`, `ECONNREFUSED`)                   |
| `{ timeoutMs: 10, retries: 2, mode: "async" }`, answer after 60 ms | resolves the result after 60 ms, one request                                   |
| `{ retries: 3 }`, answer 503                                       | one request                                                                    |
| no `VOKE_REMOTE_<NAME>_ORIGIN`                                     | rejects `VokeConfigError` (`CONFIG_ERROR`), documented in the guide            |
| 200 with body `{"hello":1}`                                        | resolves `undefined` when the contract output is `true`, else `INVALID_RESULT` |

The same probe confirmed two facts the fix relies on (Bun 1.4.4): `fetch` with
`signal: AbortSignal.timeout(n)` rejects with a `DOMException` named `TimeoutError` both
before the headers arrive and while `response.text()` is reading a stalled body.

The invoke types this plan reads but does not edit (`packages/core/src/invoke.ts:59-68,718-731`):

```ts
export type InvokeErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_PAYLOAD"
  | "INVALID_RESULT"
  | "LOCAL_FUNCTION_FAILED"
  | "MISSING_FUNCTION"
  | "MISSING_TRANSPORT"
  | "TIMEOUT"
  | "TRANSPORT_FAILED"
  | "TRANSPORT_STATUS_ERROR";

export interface InvokeOptions {
  executionName?: string;
  mode?: InvokeMode;
  runtime?: InvokeRuntime;
  trace?: InvokeTrace;
  retries?: number;
  timeoutMs?: number;
  transport?: InvokeTransport;
  onAsyncError?: (error: InvokeError) => void;
}
```

`InvokeError` (`invoke.ts:79-95`) takes `{ cause?, code, functionName?, issues?, requestId?, statusCode? }`.

The Dev Function Invoke Endpoint (`packages/core/src/remote.ts:692-698`) reads the request
with `(await c.req.json()) as RemoteInvokeRequest`. Through the Gateway, a body of `{oops`
answers 500 `INTERNAL_SERVER_ERROR` and a body of `null` answers 500 with the detail
`null is not an object (evaluating 'body.contractFingerprint')`.

Tests: `packages/core/test/remote-functions.test.ts` has 6 tests; two of them call
`createRemoteFunctions` (lines 82-155 and 284-321) and they import core's copy.
`packages/remote/test/dev-endpoints.test.ts` has 3 tests, none of which calls
`createRemoteFunctions`. `packages/core/test/public-surface.test.ts:219-225` checks only that
`@voke/remote` _contains_ `createRemoteFunctions`.

`@voke/http`: `diff packages/core/src/response.ts packages/http/src/index.ts` shows the first
70 lines identical and 11 extra lines in `@voke/http`: the interfaces `JsonBody` and
`JsonErrorBody` (`packages/http/src/index.ts:72-81`), which nothing imports
(`grep -rn "JsonBody\|JsonErrorBody" packages apps/docs/content docs` finds only the two
definitions and core's own `packages/core/src/http.ts:3,7`). `@voke/http` has no dependencies
and no tests. Core uses `./response` in `http.ts:1` and `app.ts:28`.

### Findings checked and dropped

- "`examples/cross-function` uses Remote Function Registries": it does not. It calls
  `functions.invoke` inside one project. No example uses `@voke/remote`; this plan adds none
  (it would need two projects and two dev servers; see Maintenance notes).
- "about 161 differing lines": confirmed, but only the five differences in the table above
  are behaviour or structure.

## Decisions taken in this plan

**D1. Split by caller instead of making one file a re-export.** Core keeps the project side,
which its own config, CLI and Gateway call: the Function Contract Artifact
(`createFunctionContractArtifact`, `toContractJsonSchema`, the fingerprint), remote config
(`defineRemoteConfig`, `remoteEnvironment`), Remote Code Generation (`renderRemoteModule`,
`generateRemoteModules`) and the endpoints (`mountDevFunctionEndpoints`). `@voke/remote` keeps
the Remote Function Registry: `createRemoteFunctions`, its types, the JSON Schema check and
the origin lookup. Each side deletes the other's half.
_Why_: a re-export is impossible in either direction. Core cannot import `@voke/remote`, and
`@voke/remote` can import only the root of `voke`, where `createRemoteFunctions` must not
appear (`public-surface.test.ts:223`). A dynamic `import("@voke/remote")` from the CLI does
not help `config.ts` and `app.ts`, which run synchronously.
_Reverse_: to move the client into core, export `createRemoteFunctions` from the root, change
`renderRemoteModule` to import from `voke`, and delete `packages/remote`; that contradicts
ADR 0007 (specialized packages) and needs a new ADR.

**D2. `@voke/remote` exports one runtime symbol, `createRemoteFunctions`.** The six other
runtime exports are removed without aliases (`createFunctionContractArtifact`,
`defineRemoteConfig`, `generateRemoteModules`, `mountDevFunctionEndpoints`,
`remoteEnvironment`, `renderRemoteModule`), with the types `RemoteTarget`, `VokeRemoteConfig`,
`VokeRemoteConfigInput` and `GenerateRemoteOptions`. No file in the repository uses them from
`@voke/remote`; the one supported way to do each is `voke remote generate`, `remotes` in
`voke.config.ts`, and the Gateway under `voke dev`. A project that publishes its contract
elsewhere saves the body of `GET /_voke/contract`.
_Reverse_: export the wanted function from the root of `voke`.

**D3. The artifact types are defined in core and exported from the root as types.** Add to
`packages/core/src/index.ts`: `type FunctionContractArtifact`, `type FunctionContractMetadata`
and `type JsonSchema as ContractJsonSchema` (the root name says which JSON Schema it is).
`@voke/remote` imports them and does not re-export them.
_Why_: the artifact is the format core serves; defining it again in the client is the
duplication this plan removes. _Reverse_: re-export them from `@voke/remote`.

**D4. `toContractJsonSchema` leaves the root of `voke`.** Its only outside user was the copy
being deleted. It stays in `packages/core/src/remote.ts`, tested by
`packages/core/test/standard-schema.test.ts` (which already imports it from `../src/remote`).
_Reverse_: restore the export line and the entry in `public-surface.test.ts`.

**D5. A Remote Function Registry accepts `timeoutMs`, `retries` and `trace`, and rejects every
other option.** The options type becomes
`RemoteInvokeOptions = Pick<InvokeOptions, "retries" | "timeoutMs" | "trace">`, so `mode`,
`executionName`, `runtime`, `transport` and `onAsyncError` do not compile. At run time, any
other key whose value is not `undefined`, a `timeoutMs` that is not a finite number above 0,
or a `retries` that is not an integer of 0 or more rejects with `InvokeError`
`INVALID_OPTIONS` before any request.
_Why `mode` is rejected_: the Dev Function Invoke Endpoint has no asynchronous mode, and the
registry's return type is always the result. Accepting `mode: "async"` and running
synchronously is the current bug. `mode: "sync"` is rejected too, so the rule is one
sentence. _Reverse_: add `mode` to the wire request and a 202 answer to the endpoint, then
widen the type.

**D6. `timeoutMs` bounds one attempt and cancels its request.** Each attempt passes
`AbortSignal.timeout(timeoutMs)` to `fetch`; the limit covers the request and reading the
body. On expiry the call rejects with `InvokeError` `TIMEOUT`. The provider project's handler
may keep running. _Reverse_: n/a (the alternative, `Promise.race` without a signal as in
`invoke.ts:1530-1541`, leaves the request open).

**D7. `retries` repeats an attempt only when repeating can help.** Retried: `TIMEOUT`, and
`TRANSPORT_FAILED` with no `statusCode` (the request failed) or a `statusCode` of 500 or
more. Not retried: any 4xx (404, contract drift 409, an invalid payload 400), a 2xx that is
not a JSON object, `INVALID_RESULT`, and everything checked before the first request. No
delay between attempts, as in `functions.invoke`. The last attempt's error is the one
thrown. _Reverse_: change the one predicate.

**D8. Error codes stay as documented; only the raw errors change.** The mapping is the table
in Step 2. A non-2xx answer keeps `TRANSPORT_FAILED` (404 keeps `MISSING_FUNCTION`), now
always with `statusCode`. Contract drift stays `TRANSPORT_FAILED` with `statusCode: 409` and
the provider's message, because a dedicated code needs a new `InvokeErrorCode` in
`invoke.ts`, which plan 024 owns. A missing runtime target stays a `VokeConfigError`: it is a
configuration error, the guide documents it, and `invokeRegistryFunction`
(`invoke.ts:1863-1876`) does the same for a registry that was never activated.
_Alternative not taken_: use `TRANSPORT_STATUS_ERROR` for non-2xx answers, as the Lambda
transport does. It changes two documented pages for no caller in the repository; do it
together with a drift code if `InvokeErrorCode` is ever extended.

**D9. The Dev Function Invoke Endpoint answers 400 `BAD_REQUEST` to a request body that is
not a JSON object.** Plan 023 leaves this endpoint to this plan. Its mapping of a thrown
`InvokeError` to 400 and anything else to 500 is unchanged.

**D10. `@voke/http` stays a copy of `packages/core/src/response.ts`, pinned by a test.**
Removing the copy needs core to import `@voke/http` (no cycle would arise, since `@voke/http`
has no dependencies, but the rule above forbids it), or the helpers to become root exports
(the test "keeps HTTP helpers in @voke/http" in `public-surface.test.ts` asserts they are not), or the package to be deleted
(contradicts ADR 0007). Each is an owner decision about the public surface, and the copy is
70 lines of pure functions with no drift. This plan deletes the two unused interfaces from
`@voke/http` and adds a test that fails when the two files differ.
_Reverse / follow-up_: if the owner allows core to depend on `@voke/http`, delete
`response.ts`, import from `@voke/http` in `http.ts` and `app.ts`, and drop the test.

## Commands you will need

| Purpose               | Command                                                                                                                                | Expected on success                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Remote package tests  | `cd packages/remote && bun test`                                                                                                       | all pass                                        |
| Core tests touched    | `cd packages/core && bun test test/remote-functions.test.ts test/public-surface.test.ts test/standard-schema.test.ts test/dev.test.ts` | all pass                                        |
| Typecheck one package | `cd packages/<pkg> && bun run typecheck`                                                                                               | exit 0                                          |
| Whole repository      | `bun run typecheck` and `bun run test` (from the root)                                                                                 | exit 0                                          |
| Lint and format       | `bun run check`; fix with `bun x ultracite fix`                                                                                        | exit 0                                          |
| Docs samples          | `cd apps/docs && bun run check:samples` and `bun run typecheck`                                                                        | exit 0                                          |
| Lockfile              | `bun install`                                                                                                                          | `bun.lock` changes only under `packages/remote` |

`check:samples` is listed in `apps/docs/package.json` and was not run at planning time; if it
fails before your change, record that and rely on `bun run typecheck` and `bun run test` in
`apps/docs`.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): each behaviour in Step 2 and Step 4 gets a failing test before the
  change.
- No real network in tests. Replace `globalThis.fetch` inside a helper that restores it in
  `finally`, keeping `preconnect`; the pattern is `withGatewayFetch` in
  `packages/core/test/remote-functions.test.ts:42-72`.
- Restore environment variables after each test by deleting them when they were unset.
  Assigning `undefined` stores the string `"undefined"` in Bun
  (`packages/core/test/support/env.ts`). Never replace `process.env`.
- Under `VOKE_DEV_SUMMARY=1` the Gateway prints the Dev Function Summary with `console.info`;
  tests silence and restore it (same test file, lines 35-39 and 76-80).
- Ultracite rules: `const`, arrow functions, `for...of`, no `any`, no `console.log`, throw
  `Error` objects, top-level regex literals.
- `@voke/remote` runs inside a consuming project's Function, so it uses `process.env` and Web
  APIs only: no `Bun` global, no `node:fs`.
- The wire protocol is spelled once per side by necessity: the path
  `/_voke/functions/<key>/invoke`, the request body `{ contractFingerprint, payload, trace }`
  and the variable `VOKE_REMOTE_<NAME>_ORIGIN`. Do not add root exports to share them; the
  tests in Steps 1 and 3 pin both sides together.

## Scope

**In scope**:

- `packages/remote/src/index.ts`, `packages/remote/package.json`, `packages/remote/README.md`
- `packages/remote/test/remote-functions.test.ts` (create),
  `packages/remote/test/options-typecheck.ts` (create),
  `packages/remote/test/dev-endpoints.test.ts` (delete after moving its tests)
- `packages/core/src/remote.ts`, `packages/core/src/index.ts`
- `packages/core/test/remote-functions.test.ts`, `packages/core/test/public-surface.test.ts`
- `packages/http/src/index.ts`
- `bun.lock` (dependency removal only)
- `apps/docs/content/docs/guides/remote-functions.mdx`,
  `apps/docs/content/docs/reference/packages.mdx`, `apps/docs/content/docs/reference/errors.mdx`
- `docs/stable-public-surface.md`, `CONTEXT.md`, one new file under `docs/adr/`

**Out of scope**:

- `packages/core/src/invoke.ts` (plan 024) and the error mapping in `packages/core/src/app.ts`
  (plan 023). No new `InvokeErrorCode`.
- `packages/core/src/cli.ts`, `cli-spec.ts` (plans 025 and 026), `config.ts`, `dev.ts`: their
  imports from `./remote` keep working unchanged.
- `packages/core/src/response.ts` and `http.ts`: not edited (D10).
- Deployed cross-project invocation, tokens for the endpoints, an asynchronous remote mode,
  a remote example project.
- `docs/reviews/public-api-release-gate.md` (stale; plan 034).

## Git workflow

- Branch: `feature/single-remote-implementation`.
- Commit only if the operator authorised it. Subjects are imperative sentences that state the
  outcome, for example "Reject failed remote calls with an InvokeError" and "Keep one
  implementation of Remote Function Registries".
- Do not push or open a pull request unless instructed.

## Steps

### Step 1: Tests for the client, in the package users import

Create `packages/remote/test/remote-functions.test.ts`. It imports `createRemoteFunctions`
from `../src/index` and `createFunctions`, `fn`, `voke`, `InvokeError`, `VokeConfigError`
from `voke`. Write a small Standard Schema helper that carries a `jsonSchema` property (copy
the `schema` helper from `packages/core/test/remote-functions.test.ts:22-32`).

Group A, against a real Gateway (`voke(functions, { config: { name: "users" } })` with
`VOKE_DEV_SUMMARY=1`, routed through the stubbed `fetch`). Move the two tests from
`packages/core/test/remote-functions.test.ts` (lines 82-155 and 284-321) here and delete them
there in Step 3:

1. invokes a Function of another project and passes `trace` (expects the result and
   `requestId`).
2. a stale fingerprint rejects with `InvokeError`, `code: "TRANSPORT_FAILED"`,
   `statusCode: 409`, message
   ``Remote Function contract drift for "users". Run `voke remote generate users`.``
3. a key the provider project does not have (build the artifact by hand with an extra key)
   rejects with `MISSING_FUNCTION`, `statusCode: 404`.

Group A passes before any source change. Group B uses a stubbed `fetch` that returns a fixed
`Response` or rejects, and counts calls. Each case asserts `error instanceof InvokeError`,
`code`, `functionName`, and `statusCode` where the table in Step 2 gives one:

4. 502 with an HTML body → `TRANSPORT_FAILED`, `statusCode: 502`, message
   `Remote Function invocation failed with HTTP 502`.
5. 200 with an empty body, and 200 with body `null` → `TRANSPORT_FAILED`, `statusCode: 200`.
6. 500 with body `{"error":"plain"}` → `TRANSPORT_FAILED` with the HTTP-status message, not an
   empty one.
7. `fetch` rejects with `new TypeError("fetch failed")` → `TRANSPORT_FAILED`, no `statusCode`,
   `cause` is that error.
8. `{ timeoutMs: 5 }` with a `fetch` that settles only when `init.signal` aborts (reject with
   `init.signal.reason` in an `abort` listener) → `TIMEOUT`, message
   `Remote Function getUser timed out after 5ms`.
9. `{ retries: 2 }` with 503 answers → three requests, then `TRANSPORT_FAILED`; with a 503
   followed by a 200 `{ data }` → two requests and the result.
10. `{ retries: 2 }` with a 400 answer, and with a 409 answer → one request each.
11. `{ retries: 2, timeoutMs: 5 }` with the never-settling `fetch` → three requests, `TIMEOUT`.
12. unsupported options, cast through `as never`: `{ mode: "async" }`, `{ mode: "sync" }`,
    `{ executionName: "x" }`, `{ timeoutMs: 0 }`, `{ timeoutMs: Number.NaN }`,
    `{ retries: -1 }`, `{ retries: 1.5 }` → `INVALID_OPTIONS`, zero requests. `{ mode: undefined }`
    is accepted.
13. no `VOKE_REMOTE_USERS_ORIGIN` → `VokeConfigError` (unchanged behaviour, now pinned).
14. a payload that fails the contract input → `INVALID_PAYLOAD`, zero requests; a result that
    fails the contract output → `INVALID_RESULT`.
15. `createRemoteFunctions("wallet", artifactForUsers)` throws `VokeConfigError`.

Create `packages/remote/test/options-typecheck.ts` (compiled by the package's `typecheck`;
model: `packages/core/test/package-boundaries-typecheck.ts`): a registry call with
`{ retries: 1, timeoutMs: 100, trace: {} }` compiles; `{ mode: "async" }` and
`{ executionName: "x" }` each sit under `// @ts-expect-error`.

**Evidence**: `cd packages/remote && bun test` → group A and cases 13-15 pass; cases 4-12
fail. `bun run typecheck` fails on the two `@ts-expect-error` lines (unused directive).

### Step 2: Make every failure an `InvokeError` and honour the options

Edit `createRemoteFunctions` in `packages/remote/src/index.ts`. Target shape:

```ts
export type RemoteInvokeOptions = Pick<
  InvokeOptions,
  "retries" | "timeoutMs" | "trace"
>;

// inside invoke(functionName, payload, options = {}):
//  1. contract lookup            -> MISSING_FUNCTION
//  2. assertOptions(options)     -> INVALID_OPTIONS
//  3. validate payload           -> INVALID_PAYLOAD
//  4. const url = invokeUrl(...) -> VokeConfigError when there is no runtime target
//  5. attempts 0..retries: requestOnce(); rethrow unless isRetryable(error) and attempts remain
//  6. validate result            -> INVALID_RESULT

const requestOnce = async (/* url, functionName, requestBody, timeoutMs */) => {
  const signal =
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(url, {
      body,
      headers,
      method: "POST",
      signal,
    });
    return { body: parseJson(await response.text()), response };
  } catch (error) {
    throw signal?.aborted === true
      ? new InvokeError(/* TIMEOUT */)
      : new InvokeError(/* TRANSPORT_FAILED, cause: error */);
  }
};
```

`parseJson` returns a marker (for example `undefined`) when `JSON.parse` throws; that is the
only place an error is caught without being rethrown, because "not JSON" is a normal answer
to map. Both `RemoteFunctionRegistry` overloads take `options?: RemoteInvokeOptions`.

The mapping, complete:

| Situation                                                                | Rejects with                                                                                                | `statusCode` | Message                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key not in the artifact                                                  | `MISSING_FUNCTION`                                                                                          | none         | `Remote Function not found: <key>` (unchanged)                                                                                                           |
| unsupported or invalid option                                            | `INVALID_OPTIONS`                                                                                           | none         | `Remote Function <key> does not support the invoke option "<option>"` or `... invoke option "<option>" must be <rule>`                                   |
| payload fails the contract input                                         | `INVALID_PAYLOAD`                                                                                           | none         | unchanged                                                                                                                                                |
| no runtime target                                                        | `VokeConfigError`                                                                                           | n/a          | unchanged                                                                                                                                                |
| `fetch` or the body read rejects                                         | `TRANSPORT_FAILED`, `cause` set                                                                             | none         | `Remote Function <key> request failed: <cause message>`                                                                                                  |
| the attempt exceeds `timeoutMs`                                          | `TIMEOUT`                                                                                                   | none         | `Remote Function <key> timed out after <n>ms`                                                                                                            |
| status 404                                                               | `MISSING_FUNCTION`                                                                                          | 404          | provider's message, else the HTTP-status message                                                                                                         |
| any other non-2xx                                                        | `TRANSPORT_FAILED`                                                                                          | the status   | `body.error.message` when the body is an object whose `error.message` is a non-empty string, else `Remote Function invocation failed with HTTP <status>` |
| 2xx whose body is not a JSON object (unparseable, `null`, array, scalar) | `TRANSPORT_FAILED`                                                                                          | the status   | `Remote Function <key> answered HTTP <status> without a Voke data envelope`                                                                              |
| 2xx JSON object                                                          | result is `body.data` (`undefined` when absent, as today: a handler that returns `undefined` produces `{}`) |              |                                                                                                                                                          |
| result fails the contract output                                         | `INVALID_RESULT`                                                                                            | none         | unchanged                                                                                                                                                |

Every `InvokeError` sets `functionName`. `isRetryable` is D7 exactly.

**Evidence**: `cd packages/remote && bun test && bun run typecheck` → all pass.
`grep -n "response.json()" packages/remote/src/index.ts` finds only the line in
`generateRemoteModules`, which Step 3 deletes.

### Step 3: Cut each copy down to its side

Tests first:

1. In `packages/core/test/public-surface.test.ts`, replace the body of "keeps Remote Function
   helpers in @voke/remote" with an exact list:
   `expect(Object.keys(remote).toSorted()).toEqual(["createRemoteFunctions"]);` and keep the
   two `in voke` assertions. Remove `"toContractJsonSchema"` and its comment from the root
   list (D4). Both fail now.
2. In `packages/core/test/remote-functions.test.ts`: delete the two tests moved in Step 1;
   move in the three tests of `packages/remote/test/dev-endpoints.test.ts`, rewritten to go
   through the Gateway (`voke(functions, { config: { name: "users" } })` with
   `VOKE_DEV_SUMMARY=1`, then `gateway.request("/_voke/functions/<key>/invoke", ...)` and
   `gateway.request("/_voke/contract")`) instead of mounting on a bare Hono app; the expected
   bodies and statuses stay as written there (`CONTRACT_DRIFT` 409, `NOT_FOUND` 404,
   `BAD_REQUEST` 400, `INTERNAL_SERVER_ERROR` 500 with message `database unreachable`). Then
   delete `packages/remote/test/dev-endpoints.test.ts`.
3. Add one test to the same core file that pins the two sides of the environment variable:
   `remoteEnvironment({ walletAudit: { contract, origin, out } })` (from `../src/remote`) is
   applied to `process.env`, and `createRemoteFunctions("walletAudit", artifact)` imported
   from `@voke/remote` (the tsconfig path resolves it from source) reaches that origin through
   the stubbed `fetch`. It passes before and after; it fails if either side changes the name
   rule.

Then the source:

- `packages/remote/src/index.ts`: delete `createFunctionContractArtifact`, `schemaMetadata`,
  `stableStringify`, `fingerprint`, `helperKeys`, `selectedTarget`, `defineRemoteConfig`,
  `remoteEnvironment`, `remoteContractEnvName`, `generatedIdentifier`, `renderRemoteModule`,
  `GenerateRemoteOptions`, `generateRemoteModules`, `mountDevFunctionEndpoints`, the types
  `RemoteTarget`, `VokeRemoteConfig`, `VokeRemoteConfigInput`, and the local definitions of
  `JsonSchema`, `FunctionContractMetadata`, `FunctionContractArtifact`. Import the three
  artifact types from `voke` (D3). Remove the imports of `node:crypto`, `node:fs/promises`,
  `node:path`, `@voke/http` and `hono`. What remains: the JSON-Schema-to-type mapping,
  `RemoteFunctionRegistry`, `RemoteInvokeOptions`, the JSON Schema check, `toEnvKey`,
  `normalizeOrigin`, the origin lookup, the request shape and `createRemoteFunctions`.
- `packages/remote/package.json`: remove `@voke/http` and `hono` from `dependencies`. Run
  `bun install`. If a test then cannot resolve `hono`, add it to `devDependencies` only.
- `packages/core/src/remote.ts`: delete `createRemoteFunctions`, `RemoteFunctionRegistry`,
  `JsonSchemaType`, `JsonObjectType`, `RequiredKey`, `RemoteInput`, `RemoteOutput`,
  `RemotePayloadKey`, `RemoteZeroInputKey`, `JsonSchemaIssue`, `pathFor`, the four
  `validate*JsonSchema` functions, `JsonSchemaValidator`, `formatJsonSchemaIssues`,
  `resolveRemoteOrigin`, `invokeUrl`, and the imports that become unused (`InvokeOptions`,
  `readEnv`). `renderRemoteModule` keeps writing the `@voke/remote` import.
- `packages/core/src/index.ts`: replace lines 133-134 with a type-only export of
  `FunctionContractArtifact`, `FunctionContractMetadata` and `JsonSchema as ContractJsonSchema`
  from `./remote`.
- `packages/core/test/remote-functions.test.ts`: drop `createRemoteFunctions` from the
  `../src/remote` import; the new test imports it from `@voke/remote`.

**Evidence**: `grep -c "createRemoteFunctions" packages/core/src/remote.ts` → 1 (the string in
`renderRemoteModule`). `grep -nE "generateRemoteModules|mountDevFunctionEndpoints|defineRemoteConfig|remoteEnvironment|createFunctionContractArtifact|renderRemoteModule|@voke/http|hono" packages/remote/src/index.ts`
→ no match. Both packages' tests and `bun run typecheck` pass.
`git diff --stat bun.lock` shows only the `packages/remote` workspace entry.

### Step 4: The Dev Function Invoke Endpoint rejects a malformed request with 400

Add to `packages/core/test/remote-functions.test.ts`, through the Gateway as in Step 3: a
`POST` with body `{oops`, and one with body `null`, each answers 400 with
`{ error: { code: "BAD_REQUEST", message: "The Dev Function Invoke Endpoint expects a JSON object body" } }`.
Both fail today with 500. Then, in `mountDevFunctionEndpoints`, read the body inside a
`try`/`catch` for the parse failure, check it is a non-null, non-array object, and return
`jsonError(message, { code: "BAD_REQUEST", status: 400 })` otherwise. Do this before the
artifact is built.

**Evidence**: `cd packages/core && bun test test/remote-functions.test.ts` → all pass.

### Step 5: Pin the `@voke/http` copy

Add a test to `packages/core/test/public-surface.test.ts`, next to "keeps HTTP helpers in
@voke/http", using the file's `readPackageFile` helper:

```ts
test("@voke/http is the same source as core's response helpers", async () => {
  // Core cannot import @voke/* packages, so the helpers exist in both; they must not drift.
  expect(await readPackageFile("../../http/src/index.ts")).toBe(
    await readPackageFile("../src/response.ts")
  );
});
```

It fails on the 11 extra lines. Delete `JsonBody` and `JsonErrorBody` from
`packages/http/src/index.ts` (lines 71-81, including the blank line before them).

**Evidence**: the test passes; `cd packages/http && bun run typecheck` exits 0;
`bun run typecheck` at the root exits 0 (nothing imported the two interfaces).

### Step 6: Docs, vocabulary and the decision record

- `apps/docs/content/docs/guides/remote-functions.mdx`: after "Call a remote Function", add a
  short "Call options" part: a table of `trace`, `timeoutMs` (bounds each attempt and cancels
  the request; the provider project's handler may keep running) and `retries` (extra attempts
  after a timeout, a failed request or a 5xx answer; never after a 4xx), a sentence that
  `mode`, `executionName`, `runtime`, `transport` and `onAsyncError` are not accepted and
  reject with `INVALID_OPTIONS`, and one `ts twoslash` sample that reuses the generated-module
  block already on the page and calls
  `users.invoke("getUser", { id: "usr_1" }, { retries: 1, timeoutMs: 2000 })`. Replace the
  "Other failures" table with the full mapping from Step 2 in user terms, including: detect
  contract drift with `error.statusCode === 409`; `statusCode` is set whenever the provider
  project answered.
- `apps/docs/content/docs/reference/errors.mdx:118,125-131`: `statusCode` is also set for a
  Remote Function Registry failure where the other project answered; `TIMEOUT` and
  `INVALID_OPTIONS` rows mention Remote Function Registries; the `TRANSPORT_FAILED` row says
  the remote did not answer, answered with an error status, or answered without a data
  envelope.
- `apps/docs/content/docs/reference/packages.mdx`: the `@voke/remote` table (lines 209-214)
  keeps one row, `createRemoteFunctions`, plus the types `RemoteFunctionRegistry` and
  `RemoteInvokeOptions`; add a sentence that `voke remote generate`, `remotes` and the
  endpoints under `voke dev` are part of `voke`. Line 97: remove the `toContractJsonSchema`
  sentence and say `@voke/openapi` uses `readJsonSchema`; add the three artifact types to the
  types row of the `voke` table.
- `docs/stable-public-surface.md`: line 24 becomes "Remote Function Registries: use
  `@voke/remote` (`createRemoteFunctions`); Remote Code Generation, remote config and the Dev
  Function Invoke Endpoint are built into `voke`"; line 27 drops `toContractJsonSchema` and
  `@voke/remote`; add the three root type exports.
- `packages/remote/README.md`: no export list exists there; leave unless it names a removed
  export.
- `CONTEXT.md`: no new term. Change the **Remote Helper** definition (line 59-60) to "The
  specialized utility that constructs and invokes a **Remote Function Registry** from a
  **Function Contract Artifact**." and add two relationship lines near line 296: "The root
  `voke` package produces the **Function Contract Artifact**, runs **Remote Code Generation**
  and serves the **Dev Function Invoke Endpoint**." and "A **Remote Function Registry**
  rejects a failed call with an `InvokeError`, and rejects invoke options it does not
  support."
- New ADR, next free number at execution time (0018 at planning time; plans 027–029 may take
  it first), `docs/adr/NNNN-remote-ownership-split.md`, three short paragraphs: the split of
  D1 and why a re-export is impossible; D2 and D4 (the removed exports); D8 and D5 (codes kept,
  options accepted) with the deferred items from Maintenance notes. State that it refines
  ADR 0007 (specialized packages) for a helper whose CLI and Gateway halves must stay in core.

**Evidence**: `cd apps/docs && bun run test && bun run typecheck` exit 0 (and
`bun run check:samples` if it worked before); `cd packages/core && bun test test/public-surface.test.ts`
passes (it reads these pages).

## Test plan

- `packages/remote/test/remote-functions.test.ts` (new): the 15 cases of Step 1.
- `packages/remote/test/options-typecheck.ts` (new): the options type.
- `packages/core/test/remote-functions.test.ts`: keeps its four project-side tests (Zod and
  `@voke/schema` artifacts, Runtime Variables excluded, generated modules), gains the three
  endpoint tests through the Gateway, the environment-name pin and the two malformed-body
  cases; loses the two client tests.
- `packages/core/test/public-surface.test.ts`: exact `@voke/remote` list, root list without
  `toContractJsonSchema`, the `@voke/http` identity test.
- Unchanged and still green: `packages/core/test/standard-schema.test.ts` (imports
  `toContractJsonSchema` from `../src/remote`), `packages/core/test/dev.test.ts:263-267`
  (`VOKE_REMOTE_*` variables).
- Final: `bun run check`, `bun run typecheck`, `bun run test` from the root.

## Done criteria

- [ ] `packages/core/src/remote.ts` and `packages/remote/src/index.ts` define nothing in
      common except the wire pieces each side must spell: `normalizeOrigin`, the
      `VOKE_REMOTE_<NAME>_ORIGIN` name (with `toEnvKey` private in `@voke/remote`) and the
      `RemoteInvokeRequest` shape.
- [ ] `Object.keys(await import("@voke/remote"))` is `["createRemoteFunctions"]`, pinned by
      `public-surface.test.ts`; `toContractJsonSchema` is not a root export.
- [ ] `packages/remote/package.json` depends on `voke` only; `bun.lock` matches.
- [ ] Every case in Step 1 passes: no remote call rejects with `SyntaxError`, `TypeError` or
      `DOMException`; `timeoutMs` and `retries` behave as in D6 and D7; unsupported options
      reject with `INVALID_OPTIONS` and do not compile.
- [ ] The Dev Function Invoke Endpoint answers 400 `BAD_REQUEST` to `{oops` and to `null`.
- [ ] `packages/http/src/index.ts` and `packages/core/src/response.ts` are identical, pinned
      by a test.
- [ ] The guide, the errors and packages references, `docs/stable-public-surface.md`,
      `CONTEXT.md` and a new ADR describe the split, the options and the codes.
- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0.
- [ ] `git status --short` shows only in-scope paths (plus the three entries that predate
      this plan: `apps/docs/next-env.d.ts`, `apps/docs/.gitignore`, `apps/docs/.impeccable/`).

## STOP conditions

- `packages/core/src/config.ts`, `dev.ts`, `cli.ts` or `app.ts` turn out to need
  `createRemoteFunctions` or the JSON Schema check (some earlier plan added a caller): the
  split in D1 no longer holds; report instead of copying code back.
- Plan 024 renamed or removed `retries`, `timeoutMs` or `trace` on `InvokeOptions`, or
  `INVALID_OPTIONS` / `TIMEOUT` / `TRANSPORT_FAILED` on `InvokeErrorCode`: the options type and
  the mapping need a new decision.
- A file outside this repository's `packages/remote` imports one of the six removed exports
  from `@voke/remote` (search again before deleting): removing it needs the owner's choice of
  where it lives.
- `bun install` rewrites parts of `bun.lock` unrelated to `packages/remote`: restore the
  lockfile, remove only the two dependency lines of the `packages/remote` workspace entry by
  hand, and check with `bun install --frozen-lockfile`; report if that fails.
- Making a case pass would need an edit to `packages/core/src/invoke.ts` or `app.ts`.

## Maintenance notes

- Reviewers: check the retry predicate (D7) and that the timeout signal is created per
  attempt, not per call; check that nothing in `packages/remote/src/index.ts` uses `Bun` or
  `node:` modules.
- The Function Contract Artifact fingerprint is now computed in one place
  (`packages/core/src/remote.ts`). Changing `stableStringify` or the artifact shape changes
  every fingerprint; consumers then run `voke remote generate` once.
- The environment variable name and the wire request are written on both sides and held
  together by tests, not by a shared export. If a third consumer appears, export the pieces
  from the root of `voke` instead of copying again.
- Plan 034 (release): `@voke/remote` no longer depends on `hono` or `@voke/http`.
- Deferred, with reasons:
  - A `CONTRACT_DRIFT` invoke code, and `TRANSPORT_STATUS_ERROR` for non-2xx answers: both
    change `InvokeErrorCode` or documented codes (D8).
  - Forwarding the provider project's `InvokeError` code through the endpoint (today every
    `InvokeError` there becomes 400 `BAD_REQUEST`, including the provider's own
    `INVALID_RESULT`): it needs the error mapping plan 023 settles.
  - `issues` on `INVALID_PAYLOAD` / `INVALID_RESULT` from a Remote Function Registry (the
    JSON Schema check produces string paths, `ValidationIssue` uses path segments).
  - Asynchronous remote calls, deployed cross-project invocation and endpoint tokens (ADR 0004
    defers the last two).
  - A two-project example for Remote Function Registries; none exists today.
  - Merging `@voke/http` with `packages/core/src/response.ts` (D10): an owner decision on
    whether core may depend on a dependency-free `@voke/*` package.
