# Stable Public Surface

This inventory defines the intended stable API surface for the first stable Voke release. New exports should be added deliberately, with tests that explain why the symbol belongs in that surface.

## Root Package: `voke`

Use the root package for the common Function-first Gateway authoring path:

- Function and Gateway authoring: `api`, `createGateway`, `Voke`, `defineFunction`, `defineFunctions`
- Function Contract helpers: `StandardSchemaV1`-compatible schemas accepted by `defineFunction(...)` and the Route Builder
- Route Builder support: `new Voke().get(...)`, `.post(...)`, `.put(...)`, `.patch(...)`, `.delete(...)`, `.head(...)`, `.options(...)`, and `.route(...)`
- Config: `defineConfig`, `loadVokeConfig`, `getConfig`
- HTTP helpers: `json`, `jsonError`
- Request context helpers: `awsContext`, `awsEvent`, `requestId`
- Runtime AWS binding helpers: `bindResource`, `createAwsClientConfig`
- CloudFormation synthesis entrypoint: `synthesizeCloudFormation`
- Internal model inspection: `createInternalModel` and the `VokeModel*` types used by model-backed synthesis
- Local development helpers: `createFlociComposeConfig`, `createLocalAwsEnvironment`, `createLocalBootstrapPlan`, `createLocalResourceBindings`
- Invoke helpers: `functions.invoke(...)`, `functions.route(...)`, and `withInvokeTrace`
- Test helpers used by stable examples: `createHttpApiEvent`, `createTestClient`, `createInvokeTestClient`, `createStackTestContext`

The root keeps `createApiApp()` and `routeModule()` as Hono compatibility helpers, but first-party docs and examples should lead with `new Voke()`, `defineFunction`, `defineFunctions`, and `createGateway`.

The root should not export removed pre-stable APIs such as `createFunctionRegistry()`, global `invoke()`, `registerLocalFunction()`, or `resetLocalFunctions()`. It should also not export AWS resource builders such as `dynamodbTable()` or low-level Lambda adapter internals.

## AWS Subpath: `voke/aws`

Use `voke/aws` for AWS-specific authoring and runtime binding helpers:

- Resource builders: `dynamodbTable`, `sqsQueue`, `snsTopic`, `eventBus`, `s3Bucket`, `secret`, `ssmParameter`
- Runtime binding helpers: `bindResource`, `createAwsClientConfig`

Resource builders live here so `voke.config.ts` can stay readable and domain-oriented:

```ts
import { defineConfig } from "voke";
import { dynamodbTable, sqsQueue } from "voke/aws";
```

## Specialized Subpaths

These subpaths are stable, but should be used only when the caller needs the specialized surface directly:

- `voke/cloudformation`
- `voke/e2e`
- `voke/invoke`
- `voke/local`
- `voke/serverless-migration`

## Not Stable Package Subpaths

The CLI and low-level Lambda adapter modules are implementation details for now. They can still be tested internally by source path, but they should not be published as package subpaths:

- `voke/cli`
- `voke/aws-lambda`
- `voke/app`
- `voke/api`
- `voke/config`
- `voke/context`
- `voke/http`

## Guardrails

- Keep root exports small and tied to the common DX path.
- Prefer domain subpaths over broad root exports when a helper belongs to a specific area.
- Do not add a package export just because a file exists under `src/`.
- Add or update public surface tests whenever this inventory changes.
- Treat `bun run typecheck` as a required release gate, alongside the relevant behavior tests, so public generics and model contracts stay stable.
