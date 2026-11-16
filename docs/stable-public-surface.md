# Stable Public Surface

This inventory defines the intended stable API surface for the first stable Voke release. New exports should be added deliberately, with tests that explain why the symbol belongs in that surface.

Each setting has one spelling and each API has one name ([opinionated-framework ADR](./adr/0007-opinionated-framework.md)). Removed spellings are not kept as aliases. `packages/core/test/public-surface.test.ts` is the single test that pins every package's export list.

## Root Package: `voke`

Use the root package for the common Function-first Gateway authoring path:

- Function and Gateway authoring: `createFunctions`, `fn`, `http`, `route`, `voke`
- Function Contract helpers: `StandardSchemaV1`-compatible schemas accepted by `fn(...)`, `http(...)`, and the Route Builder
- Route Builder support: `route.get(...)`, `.post(...)`, `.put(...)`, `.patch(...)`, `.delete(...)`, `.head(...)`, `.options(...)`, and `.route(...)`
- Config: root exports `defineConfig`
- Plugins ([ADR 0015](./adr/0015-plugin-contract.md)): the `VokePlugin` contract types (`PluginRuntimeCapability`, `PluginRuntimeInput`, `PluginRuntimeHooks`, `PluginContributions`, `PluginCliCapability`, `PluginCommand`, `PluginCommandInput`, `CliPositionalSpec`, `FunctionExecution`, `FunctionExecutionKind`, `FunctionWrap`) and the Provider building block `projectFunctionEntries`
- Runtime Variable primitives (provider-neutral): `createVariableSource`, `createVariableProvider`
- Error classes: `VokeConfigError`, `VokeModelError`, `VokeResourceBindingError`, `VokeRuntimeVariableError`, `InvokeError`
- Provider building blocks: `functionRegistryEntries`, `createHandlerExportName`, `runRequestAuthorizer`, `readStandardResult` and `formatValidationIssue` (read a Standard Schema result), the `BuildPlan`, `ProviderBuildInput` and `RouteAuthContext` types, and the open Event Source types `EventSourceDefinition`, `EventFunctionHandler` and `VokeModelEventSource` that Provider packages build Event Source Functions with
- Provider invoke routing: `ProviderInvokeCapability` (`transport`, `target`, `acceptsExecutionName`) and the `ProviderInvokeTarget` type; `InvokeOptions.executionName`, `AsyncInvokeResult.executionId`, and the `INVALID_OPTIONS` invoke error code
- HTTP helpers: use `@vokejs/http`
- Runtime AWS binding helpers: use `@vokejs/aws`
- CloudFormation synthesis entrypoint: use `@vokejs/aws/cloudformation`
- Internal model inspection: use root type exports from `voke`
- Remote Function Registries: use `@vokejs/remote` (`createRemoteFunctions`); Remote Code Generation, remote config and the Dev Function Invoke Endpoint are built into `voke`
- Function Contract Artifact types: `FunctionContractArtifact`, `FunctionContractMetadata` and `ContractJsonSchema`, served by `voke` and read by `@vokejs/remote`
- Build helpers: use `@vokejs/build`
- OpenAPI documents and the API Reference Page: use `@vokejs/openapi`
- JSON Schema building blocks: `readJsonSchema` (Standard JSON Schema, draft 2020-12), used by `@vokejs/openapi`; the `RouteMeta` type documents a route
- Invoke helpers: `functions.invoke(...)` and `functions.route(...)`
- Test helpers used by stable examples: use `@vokejs/testing`
- AWS-specific test helpers: use `@vokejs/aws/testing`

The root package is intentionally limited to the common authoring path. First-party docs and examples should lead with `createFunctions`, `fn`, `http`, `route`, and `voke`; AWS-specific examples should import SQS, Runtime Variables, authorizers, and provider runtime from `@vokejs/aws`, and CloudFormation resource builders from `@vokejs/aws/cloudformation`.

The root should not export removed pre-stable APIs such as `api()`, `createGateway()`, `createApiApp()`, `routeModule()`, `new Voke()`, `createFunctionRegistry()`, global `invoke()`, `registerLocalFunction()`, or `resetLocalFunctions()`. It should also not export AWS runtime variable builders, AWS resource builders such as `dynamodbTable()`, or low-level Lambda adapter internals.

## AWS Package: `@vokejs/aws`

Use `@vokejs/aws` for AWS-specific authoring and runtime binding helpers:

- Runtime Variable builders: `secret`, `parameter` (each with `.fromResource(...)`)
- Event Source Function helpers: `sqs`, `createSqsEventHandler`, `sns`, `eventBridge`, `schedule`, and their input and event types (`SnsMessage`, `SnsEventInvocationInput`, `EventBridgeEvent`, `EventBridgeEventInvocationInput`, `EventBridgePattern`, `ScheduledEvent`, `ScheduleEventInvocationInput`)
- Stream Event Source Function helpers: `kinesis`, `dynamodbStream` (handlers return a `StreamBatchResult`)
- S3 Event Source Function helper: `s3`, with `S3ObjectEvent`, `S3EventInvocationInput` and `S3EventKind`
- Durable Function helper: `durable` (handlers receive `context.durable`, the AWS SDK's `DurableContext`; types `DurableContext`, `DurableDuration`, `DurableInvokeContext`, `DurableFunctionHandler`)
- Durable Function test helpers in `@vokejs/aws/testing`: `setupDurableTests`, `teardownDurableTests`, `runDurable`
- Generated Lambda handlers: `createLambdaHandlers` (used by the entry module `voke build` generates)
- API Gateway authorizer helpers: `createAuthorizers`, `jwtAuthorizer`, `lambdaAuthorizer`, `requestAuthorizer`
- Runtime AWS client helper: `createAwsClientConfig`. Handlers read resource bindings with `context.resource(key)` for the resources their Function links in `resources`
- Plugin Provider Extension Record: `awsPolicy` (IAM statements a Plugin adds to every Function role)
- Provider: `aws`

CloudFormation resource builders live in `@vokejs/aws/cloudformation`, so runtime value loading and
infrastructure declaration do not share an import boundary: `dynamodbTable`, `sqsQueue`, `snsTopic`,
`eventBus`, `s3Bucket`, `secret`, `ssmParameter`, and `synthesizeCloudFormation`.
The Kinesis stream builder, `kinesisStream`, lives there too.

```ts
import { defineConfig } from "voke";
import { aws } from "@vokejs/aws";
import { dynamodbTable, sqsQueue } from "@vokejs/aws/cloudformation";
```

## Specialized Packages

These packages are stable, but should be used only when the caller needs the specialized surface directly:

- `@vokejs/aws`
- `@vokejs/aws/cloudformation`
- `@vokejs/aws/local`
- `@vokejs/aws/testing`
- `@vokejs/build`
- `@vokejs/http`
- `@vokejs/openapi`
- `@vokejs/idempotency`
- `@vokejs/remote`
- `@vokejs/schema`
- `@vokejs/testing`

## Not Stable Package Subpaths

The CLI, compatibility adapters, and low-level Lambda adapter modules are implementation details for now. They can still be tested internally by source path, but they should not be published as package subpaths:

- `voke/cli`
- `voke/aws`
- `voke/aws-lambda`
- `voke/app`
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
- Releases follow `docs/releasing.md`; `bun run release:check` is the gate.
