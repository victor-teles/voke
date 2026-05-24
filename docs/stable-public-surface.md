# Stable Public Surface

This inventory defines the intended stable API surface for the first stable Voke release. New exports should be added deliberately, with tests that explain why the symbol belongs in that surface.

## Root Package: `voke`

Use the root package for the common Function-first Gateway authoring path:

- Function and Gateway authoring: `createFunctions`, `fn`, `http`, `route`, `sqs`, `voke`
- Function Contract helpers: `StandardSchemaV1`-compatible schemas accepted by `fn(...)`, `http(...)`, and the Route Builder
- Route Builder support: `route.get(...)`, `.post(...)`, `.put(...)`, `.patch(...)`, `.delete(...)`, `.head(...)`, `.options(...)`, and `.route(...)`
- Config: root exports `defineConfig`; advanced config helpers live on `voke/config`
- HTTP helpers: use `voke/response`
- Request context helpers: use `voke/context`
- Runtime AWS helpers: use `voke/aws`
- Runtime Variable provider extension helpers: use `voke/variables`
- CloudFormation synthesis entrypoint: use `voke/cloudformation`
- Internal model inspection: use `voke/model`
- Local development helpers: use `voke/local`
- Invoke helpers: `functions.invoke(...)` and `functions.route(...)`; advanced invoke helpers live on `voke/invoke`
- Test helpers used by stable examples: use `voke/testing`

The root package is intentionally limited to the common authoring path. First-party docs and examples should lead with `createFunctions`, `fn`, `http`, `route`, `sqs`, and `voke`.

The root should not export removed pre-stable APIs such as `api()`, `createGateway()`, `createApiApp()`, `routeModule()`, `new Voke()`, `createFunctionRegistry()`, global `invoke()`, `registerLocalFunction()`, or `resetLocalFunctions()`. It should also not export AWS runtime variable builders, AWS resource builders such as `dynamodbTable()`, or low-level Lambda adapter internals.

## AWS Subpath: `voke/aws`

Use `voke/aws` for AWS-specific runtime helpers and the first-party AWS Runtime Variable provider:

- Runtime binding helpers: `bindResource`, `createAwsClientConfig`
- Runtime variable builders: `secret`, `parameter`

Runtime variable builders live here so Function code can declare AWS-backed runtime dependencies without importing CloudFormation-specific authoring helpers:

```ts
import { parameter, secret } from "voke/aws";
```

The move of CloudFormation resource builders out of `voke/aws` should be a clean pre-stable break with no compatibility aliases. After the move, `secret` and `parameter` from `voke/aws` are runtime variable builders only.

Runtime variable builders must distinguish external AWS names from Voke-managed resource keys at the callsite. Use the direct builder call for external AWS names and a separate resource-key form for Voke-managed resources:

```ts
secret("/prod/stripe/key");
secret.fromResource("signingSecret");
parameter("/prod/app/config");
parameter.fromResource("publicConfig");
```

Direct `secret(...)` declarations accept a Secrets Manager secret name or ARN. Direct `parameter(...)` declarations accept an SSM Parameter Store name or path.

Runtime Variables are text-first in v1. Secrets Manager values should read `SecretString`; binary-only secrets should fail with a redacted Runtime Variable error rather than guessing a binary or base64 contract.

Resource-key variable declarations should resolve the deployed source identifier through existing Voke resource bindings before loading the value from AWS.

Resource-key variable declarations should be validated during model creation when the referenced resource is known. Missing resources and mismatched resource kinds should fail as configuration/model errors rather than deferred value-read errors.

`fromResource(...)` is AWS-specific in v1 because it depends on Voke CloudFormation resource bindings and AWS resource kind validation.

Local and test variable overrides may provide project-wide defaults and Function-scoped values, with Function-scoped values taking precedence over defaults.

Local and test overrides bypass provider loading but should still preserve provider registration and declaration validation. Tests should not pass with variables from unknown third-party providers that would fail in production setup.

Local and test override values should be strings only so `text()` and `json(schema?)` behave consistently across overrides, environment fallback, and provider-loaded values.

Runtime overrides may be accepted at runtime boundaries for local, test, or adapter scenarios, but override values must never be synthesized into deployment templates as plaintext secrets.

Environment variable fallback names should mirror the same precedence. For Function `checkout` and Runtime Variable `stripeKey`, Voke should check `VOKE_VARIABLE_CHECKOUT_STRIPE_KEY` before `VOKE_VARIABLE_STRIPE_KEY`.

Environment variable fallback is Voke-level behavior and should apply to all Runtime Variables regardless of provider.

Runtime Variable declarations should synthesize per-Function least-privilege IAM permissions. Runtime Variable access must not imply every Function can read every configured secret or parameter.

Voke owns AWS fetching for Runtime Variables in the common authoring path. User code should not need to import AWS SSM or Secrets Manager clients to read declared variables.

Runtime Variable errors should expose redacted Voke-level messages while preserving provider failures as `cause` for debugging.

Runtime Variable failures should use a dedicated `VokeRuntimeVariableError` class for missing required values, provider load failures, invalid JSON, schema validation failures, unsupported binary secrets, and runtime-detected unregistered providers.

Advanced Runtime Variable loader overrides belong at the gateway, test, or runtime options boundary, not on individual variable declarations.

Runtime Variables should support provider plugins, with AWS Secrets Manager and SSM Parameter Store as the first-party initial provider implementation. Provider extension must not make provider internals part of Function Contracts or generated remote clients.

Runtime Variable provider plugins should be registered at the gateway, test, or runtime options boundary, not globally and not on individual variable declarations.

Runtime Variable providers own provider-specific source descriptors, value loading, redacted source labels, and optional deployment synthesis contributions such as IAM policy fragments. Voke owns per-Function declarations, `context.variables` typing, local and test overrides, environment fallback, caching, in-flight load deduplication, value handles, optional behavior, redacted error envelopes, and Function Contract exclusion.

Provider `load(...)` context should receive an optional abort `signal` when the invocation path has one, such as HTTP route request cancellation.

Provider `load(...)` should return a discriminated result such as `{ status: "found", value }` or `{ status: "missing" }`. Provider exceptions are treated as load failures and wrapped by Voke.

Provider found values should be strings. Providers must normalize text-like values before returning them and should reject unsupported binary or structured native values through provider-specific errors that Voke wraps.

Runtime Variable providers may expose provider-specific builders. Voke should normalize those builder outputs internally rather than requiring every provider to expose the same generic builder function.

Runtime Variable builders should return plain serializable descriptors without embedded provider clients or loader functions. Provider registration supplies behavior at runtime and synthesis time.

Runtime Variable descriptors may be shared as constants across Function declarations. Reuse must not change per-Function typing, override, IAM, or cache scope semantics.

Runtime Variable builder descriptors should be frozen so application code cannot mutate source or option data after declaration.

Runtime Variable descriptors should have a stable provider-author-facing shape, while application authors should treat descriptor objects as opaque and interact through provider-specific builders and `context.variables`.

Runtime Variable source kinds should be scoped to provider IDs. Different providers may use the same source kind name without conflict.

## Runtime Variables Subpath: `voke/variables`

Use `voke/variables` for generic Runtime Variable provider authoring types and helpers needed by third-party providers. App authors should usually use provider-specific builders such as `secret` and `parameter` from `voke/aws`; the root package should not export Runtime Variable provider APIs.

`createVariableProvider(...)` should be the stable provider-authoring entrypoint so Voke can validate provider shape and preserve inference for provider authors.

Runtime Variable provider IDs should be globally unique within a gateway/test runtime. Provider registration should reject duplicate provider IDs.

The first-party AWS Runtime Variable provider should be available automatically for sources created by `secret(...)` and `parameter(...)` from `voke/aws`. Third-party providers should be registered explicitly at the gateway, test, or runtime boundary.

Provider registration should accept provider objects, not async provider factories. Any async setup should happen inside provider loading or before the provider is passed to Voke.

Runtime Variables that reference an unregistered third-party provider should fail during gateway/model creation when Voke has enough provider registration context to detect the problem.

Runtime Variable providers may contribute permission synthesis such as IAM policy fragments, but v1 providers should not create arbitrary CloudFormation resources through the Runtime Variable provider API.

Runtime Variables should not be listed in the human-readable `voke dev` Function summary.

Runtime Variable declarations should not support descriptions or tags in v1.

Runtime Variable options should use `cache: true | false | { ttlSeconds: number }` and `load: "lazy" | "beforeHandler"`. Cache behavior is warm-runtime scoped by default.

Variables marked `load: "beforeHandler"` should load in parallel before the Function handler runs.

Pre-handler loading should respect optional semantics: missing optional variables do not prevent the handler from running, while missing required variables, invalid present values, and provider failures do.

`parameter(...)` should request decrypted SSM Parameter Store values by default so SecureString parameters work in the common path. It may expose `decrypt: false` for callers that explicitly do not want decryption.

The v1 Runtime Variable handle should support `text()`, `json(schema?)`, and `refresh()`. It should not add a special SSM `StringList` helper until Voke deliberately defines list parsing semantics.

`refresh()` should reload or invalidate the cached raw value and return the same variable handle, not a raw text or JSON value.

`refresh()` should rerun the full Runtime Variable resolution pipeline, including overrides, environment fallback, and provider loading, rather than forcing provider loading only.

Concurrent first reads of the same Runtime Variable in the same warm Function runtime should share one in-flight load.

In-flight load deduplication should still apply when `cache: false`; `cache: false` disables reuse of completed values, not sharing of simultaneous loads.

Runtime Variable caching should cache the raw provider value only. `json(schema?)` should parse and validate from the cached raw value rather than caching parsed projections.

Runtime Variable cache scope should be the Function plus Runtime Variable key, not the global AWS source identifier.

TTL-based Runtime Variable cache entries should expire relative to successful load completion. Failed loads should not populate the completed-value cache.

All Function kinds, including route-backed Functions, should expose Runtime Variables on `context.variables`. Route-backed Function handlers should receive Voke runtime context as the second handler argument, keeping HTTP request data on the first argument.

`context.variables` should be typed from the current Function's own `variables` declaration. Project-wide overrides provide values only; they do not add type-visible variables to handler context.

Runtime Variables are required by default. `optional: true` should make `text()` and `json(schema?)` return `undefined` when no value can be resolved, while still preserving redacted errors for invalid fetched values.

For optional Runtime Variables, provider-level not-found results may resolve as `undefined`, but provider access failures, network failures, KMS failures, and internal provider errors should still throw `VokeRuntimeVariableError`.

An empty `variables: {}` declaration is allowed and behaves the same as omitting `variables`.

## CloudFormation Subpath: `voke/cloudformation`

Use `voke/cloudformation` for AWS resource declarations and CloudFormation synthesis helpers:

- Resource builders: `dynamodbTable`, `sqsQueue`, `snsTopic`, `eventBus`, `s3Bucket`, `secret`, `ssmParameter`

Resource builders live here so `voke.config.ts` can stay readable and domain-oriented:

```ts
import { defineConfig } from "voke";
import { dynamodbTable, sqsQueue } from "voke/cloudformation";
```

## Specialized Subpaths

These subpaths are stable, but should be used only when the caller needs the specialized surface directly:

- `voke/build`
- `voke/cloudformation`
- `voke/config`
- `voke/context`
- `voke/dev`
- `voke/invoke`
- `voke/local`
- `voke/model`
- `voke/remote`
- `voke/response`
- `voke/schema`
- `voke/serverless-migration`
- `voke/testing`
- `voke/variables`

## Not Stable Package Subpaths

The CLI, compatibility adapters, and low-level Lambda adapter modules are implementation details for now. They can still be tested internally by source path, but they should not be published as package subpaths:

- `voke/cli`
- `voke/aws-lambda`
- `voke/app`
- `voke/api`
- `voke/http`

## Guardrails

- Keep root exports small and tied to the common DX path.
- Prefer domain subpaths over broad root exports when a helper belongs to a specific area.
- Do not add a package export just because a file exists under `src/`.
- Add or update public surface tests whenever this inventory changes.
- Treat `bun run typecheck` as a required release gate, alongside the relevant behavior tests, so public generics and model contracts stay stable.
