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
- Runtime AWS binding helpers: use `voke/aws`
- CloudFormation synthesis entrypoint: use `voke/cloudformation`
- Internal model inspection: use `voke/model`
- Local development helpers: use `voke/local`
- Invoke helpers: `functions.invoke(...)` and `functions.route(...)`; advanced invoke helpers live on `voke/invoke`
- Test helpers used by stable examples: use `voke/testing`

The root package is intentionally limited to the common authoring path. First-party docs and examples should lead with `createFunctions`, `fn`, `http`, `route`, `sqs`, and `voke`.

The root should not export removed pre-stable APIs such as `api()`, `createGateway()`, `createApiApp()`, `routeModule()`, `new Voke()`, `createFunctionRegistry()`, global `invoke()`, `registerLocalFunction()`, or `resetLocalFunctions()`. It should also not export AWS resource builders such as `dynamodbTable()` or low-level Lambda adapter internals.

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
