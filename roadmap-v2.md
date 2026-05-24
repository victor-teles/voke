# Voke Roadmap v2

This roadmap is a competitor-informed plan for growing Voke while preserving its Function-first, TypeScript-first AWS Lambda model.

Research date: 2026-05-24

## Sources Reviewed

- Serverless Framework AWS docs expose a very broad event surface: HTTP API, REST API, ALB, Cognito, EventBridge, Kafka, Kinesis, DynamoDB Streams, MSK, RabbitMQ, S3, Schedule, SNS, SQS, and WebSocket events. Source: https://www.serverless.com/framework/docs/providers/aws/events
- Serverless Framework parameters support stage-aware values, CLI overrides, secure dashboard values, and a clear resolution order. Source: https://wb.serverless.com/framework/docs-guides-parameters
- Serverless Framework CI/CD emphasizes branch-to-stage mapping, preview deployments, tests on every deploy, short-lived credentials, and automatic preview cleanup. Source: https://www.serverless.com/ci-cd
- The `serverless-esbuild` plugin shows the ecosystem expectation for zero-config TypeScript bundling, deploy-function flows, local invoke integration, offline integration, configurable watch behavior, externals, and bundle analysis hooks. Source: https://www.serverless.com/plugins/serverless-esbuild
- SST positions itself around developer-oriented infrastructure components, resource linking, a unified `sst dev` multiplexer, Live Lambda execution, VPC tunneling, monorepo structure, and Bun-compatible CLI usage. Source: https://sst.dev/docs/
- SST Live proxies remote AWS invocations back to local functions, reloads changes quickly, supports remote API/webhook/event debugging, and uses the deployed IAM permissions path. Source: https://sst.dev/docs/live
- SST config includes app-level removal policy, production remove protection, provider config, state handling, type generation, version pinning, watch paths, and stage input. Source: https://sst.dev/docs/reference/config/
- Middy provides opt-in official middleware for observability, lifecycle, request transformation, response transformation, data fetching, and event normalization. Source: https://middy.js.org/docs/middlewares/intro/
- Middy HTTP API guidance highlights request/response normalization, JSON body parsing, validation, CORS, security headers, error handling, content encoding, and common AWS HTTP API v2 gotchas. Source: https://middy.js.org/docs/events/api-gateway-http

## Current Voke Position

Voke already has a strong, differentiated core:

- Stable Function-first root surface: `createFunctions`, `fn`, `http`, `route`, `sqs`, `voke`, and `defineConfig`.
- Gateway-first local testing through `gateway.request(...)`, typed route calls through `functions.route(...)`, and typed Function invocation through `functions.invoke(...)`.
- Standard Schema-compatible Function Contracts.
- SQS Event Sources with normalized batches and partial batch failure behavior.
- HTTP API authorizers with JWT and Lambda Request Authorizer support.
- Config-first CloudFormation synthesis, AWS resource binding helpers, local AWS/Floci support, e2e helpers, and Serverless Framework migration reports.
- A small public surface that intentionally keeps response/schema helpers in subpaths.

The roadmap below should extend this core without turning Voke into YAML Serverless Framework, Pulumi/SST, or a Middy wrapper.

## Product Principles

- Keep Functions as the product primitive. Event sources, middleware, resources, deployment, and local dev all hang off the Function Registry.
- Prefer typed code over YAML and generated boilerplate.
- Keep `voke.config.ts` as project metadata and infrastructure config, not the place where handlers are composed.
- Make local tests exercise the same normalization, validation, auth, and adapter paths as deployed runtime.
- Keep AWS-specific power in domain subpaths when it would bloat the root package.
- Favor built-in boring defaults over plugin ecosystems for critical runtime behavior.
- Treat docs, examples, and migration guidance as part of the feature.

## Phase 1: Stage-Aware Config, Parameters, and Secrets

Competitor signal:

- Serverless Framework has explicit stage parameters and secure dashboard parameters.
- SST has stage input, resource removal policy, remove protection, provider configuration, version pinning, and watch configuration.

Why Voke needs it:

Voke already has `stage`, `region`, resource bindings, and deployment commands, but users will quickly need a first-class way to model per-stage domains, table names, secrets, feature flags, and production safety rules.

Deliverables:

- Add `parameters` to `defineConfig(...)` with `default` and stage-specific overrides.
- Add CLI `--param key=value` overrides for `voke synth`, `voke deploy`, `voke dev`, and migration dry runs.
- Add `secrets` declarations that bind to AWS Secrets Manager or SSM Parameter Store resources through `voke/aws`.
- Add a typed runtime helper for reading declared parameters and secrets without stringly-typed `process.env` lookups.
- Add `removalPolicy` and `protect` config for safer `voke remove` behavior.
- Add `runtimeVersion` or `vokeVersion` pinning so CI can fail on unsupported framework versions.
- Document the precedence order: CLI param, stage parameter, default parameter, environment fallback when explicitly allowed.

Acceptance tests:

- Typecheck config with stage-aware parameter inference.
- Unit tests for resolution order and missing required parameter errors.
- Synthesis tests proving environment bindings are stable and secrets do not leak into generated templates as plaintext.
- CLI tests for `--param` parsing and protected remove failures.

Docs and examples:

- Update `README.md`, config reference docs, and `examples/hello-api`.
- Add a `parameters-and-secrets` guide showing local, preview, staging, and production values.

## Phase 2: Event Source Expansion Beyond SQS

Competitor signal:

- Serverless Framework has deep AWS event coverage.
- Middy documents common AWS event shapes and normalization needs.
- SST exposes higher-level components like Queue and Cron.

Why Voke needs it:

SQS is the right first Event Source, but real serverless APIs quickly need scheduled jobs, EventBridge events, SNS fanout, S3 object events, DynamoDB/Kinesis streams, and WebSocket APIs. Voke can win by making each event source typed, locally invokable, and contract-aware.

Deliverables:

- Add `schedule(...)` Event Source for EventBridge Scheduler or EventBridge rules.
- Add `eventBridge(...)` for custom buses, detail type/source matching, and typed event detail schemas.
- Add `sns(...)` for topic subscriptions with typed message payloads.
- Add `s3(...)` for object-created/object-removed events with bucket resource binding.
- Add `stream(...)` for DynamoDB Streams and Kinesis with normalized records and batch failure semantics where AWS supports them.
- Add `websocket(...)` after HTTP + Event Source contracts stabilize, with connect/message/disconnect route builders.
- Add migration coverage for each Serverless Framework event shape as support lands.

Acceptance tests:

- For each event source, add model tests, local event invocation tests, adapter tests, CloudFormation fixture tests, and migration tests.
- Keep event source handlers distinct from HTTP routes and direct invokable Functions unless a future ADR explicitly changes that rule.
- Add edge-case tests for malformed records, schema failures, partial batch behavior, and source-specific metadata.

Docs and examples:

- Add one runnable example per event source.
- Keep examples small and domain-oriented: scheduled cleanup, user-created domain event, image-upload event, stream projection, and WebSocket chat.

## Phase 3: HTTP Cross-Cutting Features Without Middy-Style Middleware Sprawl

Competitor signal:

- Middy ships official middleware for HTTP body parsing, header/event normalization, validation, CORS, security headers, error handling, content encoding, content negotiation, multipart, and URL-encoded bodies.
- Its HTTP API guide calls out AWS HTTP API v2 details like lowercase headers, raw path/query, string bodies, cookies, and binary/base64 responses.

Why Voke needs it:

Voke should not ask users to assemble a Middy chain for the common HTTP path. The Route Builder can make the safe path terse and typed while preserving escape hatches.

Deliverables:

- Add first-party HTTP options for CORS, security headers, compression, cookies, binary responses, and content negotiation.
- Add body parser support for JSON, text, URL-encoded forms, and multipart forms.
- Add a typed error response convention that maps known Voke errors, validation errors, and user-thrown HTTP errors to stable responses.
- Add a request/response interceptor API scoped to HTTP Functions, with explicit ordering and typed context.
- Add route-level and Function-level defaults for response serialization.
- Add OpenAPI export from route contracts after request/response shape metadata is complete.

Acceptance tests:

- Integration tests for `gateway.request(...)` and Lambda HTTP API v2 adapter parity.
- Regression tests for header casing, cookies, base64 body handling, CORS preflight, validation error response shape, and binary responses.
- Type tests for route input/body/query/headers/output inference with each parser.

Docs and examples:

- Add an HTTP production hardening guide.
- Add examples for JSON APIs, file upload, signed cookie auth, and binary download.

## Phase 4: Live Dev and Remote Debug Loop

Competitor signal:

- SST `dev` starts a multiplexer for infrastructure watching, live functions, VPC tunnel, and frontend/container dev services.
- SST Live proxies AWS invocations to local functions, supports remote APIs/webhooks/events, quick reloads, breakpoints, and deployed IAM-permission behavior.
- Serverless Offline plus `serverless-esbuild` sets the expectation that local invoke/offline paths rebuild automatically.

Why Voke needs it:

Voke already has polished `voke dev` output and local Gateway invocation. The next leap is making deployed or emulated triggers hit local Function code without mocks, especially for webhooks, scheduled jobs, SQS/SNS/EventBridge, and cross-project Function invocation.

Deliverables:

- Add `voke dev --watch` with configurable watch paths and ignore rules.
- Add hot reload for local Functions without restarting the whole dev server.
- Add `voke invoke local <function>` for direct CLI invocation using the same contract parser as `functions.invoke(...)`.
- Add `voke event local <function>` for Event Source payloads using the same adapters as deployed runtime.
- Add a Live Dev proof of concept for a personal stage: deployed stub Lambda forwards invocations to the local dev process and returns the local result.
- Add opt-in VPC tunnel support only after local and Floci paths are stable.
- Add dev multiplexer support for project scripts, such as docs or frontend dev commands, without making Voke own non-Voke apps.

Acceptance tests:

- Dev server watch tests with deterministic file changes.
- CLI invoke tests for contract validation, timeout, retry, and error rendering.
- E2E tests for Live Dev can start as opt-in smoke tests gated by AWS credentials.
- Ensure Live Dev fails closed for non-personal or protected stages.

Docs and examples:

- Add `local-dev.md` with local Gateway, local Event Source, Floci, and Live Dev modes clearly separated.
- Add webhook debugging and scheduled-job debugging recipes.

## Phase 5: Resource Linking and Least-Privilege Permissions

Competitor signal:

- SST's resource linking lets runtime code use typed resource names without hardcoding values and grants permissions through the link.
- Serverless Framework users expect IAM and resource policies to be configurable, and migration reports already flag IAM work as risky.

Why Voke needs it:

Voke has `bindResource(...)` and resource builders, but it should make resource access an explicit, typed relationship from Function to resource. This is the place to improve DX, synthesis correctness, and least-privilege defaults.

Deliverables:

- Add `link` or `resources` on `fn(...)`, `http(...)`, and Event Source Functions.
- Generate typed resource bindings per Function and stage.
- Synthesize least-privilege IAM grants for common operations: DynamoDB read/write, SQS send/consume, SNS publish, S3 read/write, EventBridge put events, Secrets/SSM read.
- Add a grant escape hatch for custom IAM statements with warnings in synth output.
- Add `voke resources` CLI command to print available bindings and per-Function permissions.
- Add migration hints that translate Serverless Framework IAM statements into Voke links when possible.

Acceptance tests:

- CloudFormation tests for generated IAM policies.
- Type tests for resource binding availability per Function.
- Runtime tests proving unlinked resources produce helpful errors.
- Migration tests for IAM statement classification.

Docs and examples:

- Add a resource-linking guide.
- Update all examples to link resources from the Function that uses them.

## Phase 6: Build, Package, and Artifact Inspection

Competitor signal:

- `serverless-esbuild` provides zero-config TS/JS builds, per-function deploy compatibility, externals, watch behavior, and bundle analysis hooks.
- Serverless Framework has package/deploy-function workflows that users expect for fast iteration.

Why Voke needs it:

Voke uses Bun and already has build/synth commands. It should make artifact output predictable, inspectable, fast, and Bun-native.

Deliverables:

- Add per-Function artifact generation with stable names and manifest output.
- Add `voke package` as an explicit build-only command that writes artifacts and a manifest.
- Add `voke deploy function <name>` for fast single-Function updates when CloudFormation shape did not change.
- Add Bun-native externals, asset inclusion, and environment-specific build options.
- Add bundle size reporting and dependency inventory.
- Add optional artifact diffing to explain why a Function changed.

Acceptance tests:

- Build tests for per-Function entrypoints, shared chunks if supported, externals, assets, and deterministic manifests.
- CLI tests for invalid deploy-function when infrastructure shape changed.
- Benchmark build startup and incremental rebuild for representative examples.

Docs and examples:

- Add a build/package reference.
- Add migration docs for `package.patterns`, esbuild externals, and artifact inspection.

## Phase 7: Preview Deployments and CI/CD Recipes

Competitor signal:

- Serverless Framework CI/CD maps branches to stages, runs tests, creates preview deployments, uses short-lived credentials, and cleans previews up automatically.
- SST Console supports autodeploy and monitoring, but Voke can start with portable CLI recipes.

Why Voke needs it:

Voke should not require a SaaS dashboard to provide a clean preview workflow. It can offer conventions, generated workflow files, and safe stage lifecycle commands.

Deliverables:

- Add `voke preview create`, `voke preview deploy`, and `voke preview remove` commands as thin stage conventions around synth/deploy/remove.
- Add GitHub Actions workflow generation for Bun, typecheck, tests, synth diff, preview deploy, and cleanup.
- Add support for branch-to-stage name normalization.
- Add deploy outputs in a machine-readable file for PR comments and downstream tests.
- Add smoke-test hooks that can run against deployed preview outputs.

Acceptance tests:

- Unit tests for branch/stage normalization and cleanup safety.
- CLI tests for output files and missing credential errors.
- Generated workflow snapshot tests.

Docs and examples:

- Add a CI/CD guide for GitHub Actions.
- Add preview deployment recipe with teardown and smoke tests.

## Phase 8: Observability, Diagnostics, and Runtime Introspection

Competitor signal:

- Middy includes error logging, input/output logging, CloudWatch metrics, warmup, and Powertools/Pino integrations.
- Serverless and SST both emphasize dashboard/console visibility around deploys and runtime behavior.

Why Voke needs it:

Voke can provide lightweight observability that understands Function Registry names, Function Contracts, Event Sources, request ids, retries, and validation failures.

Deliverables:

- Add structured runtime logger with request id, Function key, source type, stage, duration, cold-start marker, and error code.
- Add opt-in input/output logging with schema-aware redaction.
- Add metrics hooks for invocation count, duration, validation failure, partial batch failure, retry, and timeout.
- Add `voke inspect` endpoint or CLI command for local Function/Event Source inventory, contracts, routes, resources, and generated fingerprints.
- Add error report rendering that points to docs for common config, binding, auth, and contract failures.

Acceptance tests:

- Snapshot tests for log records and redaction behavior.
- Runtime tests for metrics hooks and error classifications.
- CLI tests for inspect output stability.

Docs and examples:

- Add an observability guide with local logs, CloudWatch logs, metrics, and redaction.

## Phase 9: Migration Coverage and Compatibility Reports v2

Competitor signal:

- Serverless Framework users rely on plugins, broad events, variables, package settings, IAM statements, resources, and offline workflows.
- Voke already has migration reports and compatibility matrices, so this is a natural advantage if kept current.

Why Voke needs it:

Migration is a wedge. The more accurately Voke identifies safe conversions versus risky manual work, the easier it is to adopt incrementally.

Deliverables:

- Expand migration parser/report support for every event source Voke adds.
- Add variable/parameter migration suggestions for Serverless Framework `stages`, `params`, `provider.environment`, SSM, Secrets Manager, and dashboard-style parameters.
- Add plugin catalog upgrades for common plugins: offline, esbuild, webpack, localstack, dynamodb-local, step-functions, warmup, domain-manager, prune, canary deployments, and alerts.
- Add migration scoring by Function: ready, partial, blocked.
- Add generated test scaffolds for migrated routes and Event Source Functions.
- Add `voke migrate serverless --plan-only` for report-only adoption planning.

Acceptance tests:

- Fixture tests for real-world `serverless.yml` shapes.
- Report snapshot tests for each plugin category.
- Generated code typechecks for supported migrations.

Docs and examples:

- Update `docs/serverless-framework-migration.md`.
- Add a migration playbook from Serverless Offline to Voke local dev.

## Phase 10: Workflow and Orchestration Integrations

Competitor signal:

- Serverless Framework has popular Step Functions plugin usage.
- Event-driven applications often outgrow single Function handlers.

Why Voke needs it:

Voke should avoid premature workflow DSL design, but it should leave a path for typed orchestration around Functions.

Deliverables:

- Add Step Functions migration reporting first.
- Add typed `workflow(...)` exploration only after EventBridge and direct Function invocation are stable.
- Add helpers for idempotency keys, retries, and dead-letter destinations before introducing a full workflow DSL.
- Add ADR comparing Step Functions synthesis, EventBridge choreography, and userland orchestration.

Acceptance tests:

- Compatibility report tests for Step Functions plugin configs.
- ADR-backed prototype before public API.

Docs and examples:

- Add an orchestration decision guide.

## Explicit Non-Goals

- Do not introduce a broad plugin API before first-party runtime behavior is stable.
- Do not move Function composition into `voke.config.ts`.
- Do not make Pulumi, Terraform, CDK, or Serverless Framework a required runtime dependency.
- Do not expose every AWS knob on the root package.
- Do not add Middy as a required dependency. Compatibility adapters can be considered later.
- Do not promise multi-cloud support before AWS Lambda is excellent.

## Prioritized Feature Backlog

P0:

- Stage-aware parameters and secret bindings.
- Safer remove/protect lifecycle.
- Schedule and EventBridge Event Sources.
- HTTP CORS, security headers, error responses, and body parser hardening.
- `voke invoke local` and `voke event local`.
- Resource linking with least-privilege IAM for first-party resources.

P1:

- SNS, S3, DynamoDB Streams, and Kinesis Event Sources.
- OpenAPI export.
- Per-Function artifacts and `voke package`.
- Preview deployment commands and GitHub Actions generator.
- Observability hooks and `voke inspect`.
- Migration report v2 for parameters, plugins, and new event sources.

P2:

- WebSocket APIs.
- Live Dev deployed-stub proof of concept.
- VPC tunnel support.
- Single-Function deploy.
- Bundle diffing and artifact analysis.
- Step Functions compatibility and orchestration ADR.

## Suggested Implementation Order

1. Ship Phase 1 because config, stages, secrets, and safe removal support every deployment workflow.
2. Ship the P0 subset of Phase 3 because HTTP production hardening improves existing users without widening the infrastructure surface.
3. Ship schedule and EventBridge from Phase 2 because they unlock common background work with relatively simple payload models.
4. Ship Phase 5 resource linking because it improves security and makes later event sources cleaner.
5. Ship local invoke/event commands from Phase 4 because they become the verification spine for every new event source.
6. Expand migration coverage as each event source and config feature lands.
7. Then invest in build artifacts, previews, observability, and Live Dev.

## Definition of Done for Roadmap Features

Each implemented roadmap slice should include:

- A failing regression or feature test before implementation.
- Public behavior tests and TypeScript type tests where the surface is typed.
- CloudFormation fixture tests when synthesis changes.
- CLI tests when commands or flags change.
- Docs and examples when public usage changes.
- Migration report updates when the feature overlaps with Serverless Framework.
- `bun test` and `bun run typecheck` before finishing; run `bun run check` when formatting/lint-sensitive files change.

