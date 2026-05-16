# Stable Public Surface

This inventory defines the intended stable API surface for the first stable Voke release. New exports should be added deliberately, with tests that explain why the symbol belongs in that surface.

## Root Package: `voke`

Use the root package for the common application authoring path:

- API authoring: `api`, `createApiApp`, `routeModule`
- Config: `defineConfig`, `loadVokeConfig`, `getConfig`
- HTTP helpers: `json`, `jsonError`
- Request context helpers: `awsContext`, `awsEvent`, `requestId`
- Runtime AWS binding helpers: `bindResource`, `createAwsClientConfig`
- CloudFormation synthesis entrypoint: `synthesizeCloudFormation`
- Local development helpers: `createFlociComposeConfig`, `createLocalAwsEnvironment`, `createLocalBootstrapPlan`, `createLocalResourceBindings`
- Invoke helpers: `defineFunction`, `createFunctionRegistry`, `createInvoker`, `invoke`, `registerLocalFunction`, `resetLocalFunctions`, `withInvokeTrace`
- Test helpers used by stable examples: `createHttpApiEvent`, `createTestClient`, `createInvokeTestClient`, `createStackTestContext`

The root should not export AWS resource builders such as `dynamodbTable()` or low-level Lambda adapter internals.

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
