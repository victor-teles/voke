# Changelog

One section per version, newest first. Every package has the same version and is released
together; see `docs/releasing.md`.

## 0.1.0

The first release. Nine packages:

- `voke`: a TypeScript-first framework for AWS Lambda APIs: Functions, a Gateway, typed contracts and one-command deploys.
- `@vokejs/aws`: the AWS Provider for Voke: CloudFormation synthesis, Lambda handlers, deploy, local AWS and diagnostics.
- `@vokejs/build`: Lambda bundle planning for Voke projects.
- `@vokejs/http`: HTTP helpers for Voke Gateways.
- `@vokejs/idempotency`: a Voke Plugin that makes a retried handler run once, backed by a DynamoDB table it provisions.
- `@vokejs/openapi`: OpenAPI 3.1 documents and a Scalar API reference page for Voke routes.
- `@vokejs/remote`: typed Remote Function Registries for calling Voke Functions across projects.
- `@vokejs/schema`: Standard Schema helpers for Voke Function Contracts.
- `@vokejs/testing`: test clients for Voke Gateways and Function Registries.
