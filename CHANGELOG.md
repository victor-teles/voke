# Changelog

One section per version, newest first. Every package has the same version and is released
together; see `docs/releasing.md`.

## 0.1.0

The first release. Nine packages:

- `voke`: a TypeScript-first framework for AWS Lambda APIs: Functions, a Gateway, typed contracts and one-command deploys.
- `@voke/aws`: the AWS Provider for Voke: CloudFormation synthesis, Lambda handlers, deploy, local AWS and diagnostics.
- `@voke/build`: Lambda bundle planning for Voke projects.
- `@voke/http`: HTTP helpers for Voke Gateways.
- `@voke/idempotency`: a Voke Plugin that makes a retried handler run once, backed by a DynamoDB table it provisions.
- `@voke/openapi`: OpenAPI 3.1 documents and a Scalar API reference page for Voke routes.
- `@voke/remote`: typed Remote Function Registries for calling Voke Functions across projects.
- `@voke/schema`: Standard Schema helpers for Voke Function Contracts.
- `@voke/testing`: test clients for Voke Gateways and Function Registries.
