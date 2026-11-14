# Stable Public Surface

This inventory defines the intended stable API surface for the first stable Voke release. New exports should be added deliberately, with tests that explain why the symbol belongs in that surface.

## Root Package: `voke`

Use the root package for the common Function-first Gateway authoring path:

- Function and Gateway authoring: `createFunctions`, `fn`, `http`, `route`, `voke`
- Function Contract helpers: `StandardSchemaV1`-compatible schemas accepted by `fn(...)`, `http(...)`, and the Route Builder
- Route Builder support: `route.get(...)`, `.post(...)`, `.put(...)`, `.patch(...)`, `.delete(...)`, `.head(...)`, `.options(...)`, and `.route(...)`
- Config: root exports `defineConfig`
- HTTP helpers: use `@voke/http`
- Runtime AWS binding helpers: use `@voke/aws`
- CloudFormation synthesis entrypoint: use `@voke/aws/cloudformation`
- Internal model inspection: use root type exports from `voke`
- Remote helpers: use `@voke/remote`
- Build helpers: use `@voke/build`
- Invoke helpers: `functions.invoke(...)` and `functions.route(...)`
- Test helpers used by stable examples: use `@voke/testing`
- AWS-specific test helpers: use `@voke/aws/testing`

The root package is intentionally limited to the common authoring path. First-party docs and examples should lead with `createFunctions`, `fn`, `http`, `route`, and `voke`; AWS-specific examples should import SQS, resources, authorizers, and provider runtime from `@voke/aws`.

The root should not export removed pre-stable APIs such as `api()`, `createGateway()`, `createApiApp()`, `routeModule()`, `new Voke()`, `createFunctionRegistry()`, global `invoke()`, `registerLocalFunction()`, or `resetLocalFunctions()`. It should also not export AWS runtime variable builders, AWS resource builders such as `dynamodbTable()`, or low-level Lambda adapter internals.

## AWS Package: `@voke/aws`

Use `@voke/aws` for AWS-specific authoring and runtime binding helpers:

- Resource builders: `dynamodbTable`, `sqsQueue`, `snsTopic`, `eventBus`, `s3Bucket`, `secret`, `ssmParameter`
- Event Source Function helpers: `sqs`, `createSqsEventHandler`
- API Gateway authorizer helpers: `createAuthorizers`, `jwtAuthorizer`, `lambdaAuthorizer`, `requestAuthorizer`
- Runtime binding helpers: `bindResource`, `createAwsClientConfig`
- Provider: `aws`

Resource builders live here so `voke.config.ts` can stay readable and domain-oriented:

```ts
import { defineConfig } from "voke";
import { aws, dynamodbTable, sqsQueue } from "@voke/aws";
```

## Specialized Packages

These packages are stable, but should be used only when the caller needs the specialized surface directly:

- `@voke/aws`
- `@voke/aws/cloudformation`
- `@voke/aws/local`
- `@voke/aws/testing`
- `@voke/build`
- `@voke/http`
- `@voke/remote`
- `@voke/schema`
- `@voke/testing`

## Not Stable Package Subpaths

The CLI, compatibility adapters, and low-level Lambda adapter modules are implementation details for now. They can still be tested internally by source path, but they should not be published as package subpaths:

- `voke/cli`
- `voke/aws`
- `voke/aws-lambda`
- `voke/app`
- `voke/api`
- `voke/build`
- `voke/cloudformation`
- `voke/http`
- `voke/local`
- `voke/remote`
- `voke/response`
- `voke/schema`
- `voke/testing`

## Guardrails

- Keep root exports small and tied to the common DX path.
- Prefer domain subpaths over broad root exports when a helper belongs to a specific area.
- Do not add a package export just because a file exists under `src/`.
- Add or update public surface tests whenever this inventory changes.
- Treat `bun run typecheck` as a required release gate, alongside the relevant behavior tests, so public generics and model contracts stay stable.
