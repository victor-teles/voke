# Voke Stable Roadmap

Voke is an AWS Lambda framework built with Hono and Bun. The stable version should make one thing feel excellent before expanding the surface area: define Hono APIs, explicit functions, and AWS resources from a small config-first API; run them locally; build them with Bun; synthesize predictable CloudFormation from an internal model; test the behavior end to end; and migrate as much Serverless Framework behavior as possible with clear reports for anything manual.

This roadmap intentionally deprioritizes AI-native skills, broad documentation, and large example catalogs until the stable core is reliable. Documentation should still be updated when behavior changes, but docs and examples are not the main product investment for the first stable release.

## Stable Release Scope

The first stable release focuses on:

- Local development.
- API and function authoring.
- Bun build output.
- CloudFormation synthesis.
- Internal infrastructure model.
- `honoless.config.ts` as the single project configuration pattern.
- Explicit function definitions and typed invoke helpers.
- Config-driven APIs that avoid extra glue files such as `src/stack.ts`.
- Focused subpath imports for domain helpers, such as AWS resources from `honoless/aws`.
- Optional local AWS provider support, with Floci as the default adapter.
- Serverless Framework migration coverage for as many common patterns and plugins as possible.
- E2E test helpers for local/dev/build/synth workflows.

The first stable release does not prioritize:

- Built-in production deployment commands as a supported stable contract.
- AI-native skills.
- Large documentation portals.
- Broad example catalogs beyond smoke examples and regression fixtures.
- CloudFormation authoring as the direct application-facing model.

## Product Principles

- **DX first internal model:** users should define APIs, functions, resources, and bindings through a small Voke model; CloudFormation is generated from that model.
- **Config first:** project, build, local, and CloudFormation settings should flow from `honoless.config.ts` through `defineConfig()`, like Vite or Vitest.
- **One source of truth:** avoid separate project config, stack config, local bootstrap config, and example-only glue files when one normalized config can drive the workflow.
- **Implicit boring work:** APIs should do the obvious thing by default, such as `createLocalBootstrapPlan()` synthesizing a template from config when a template is not provided.
- **Simple imports by domain:** users should import AWS resource builders from `honoless/aws`, runtime config from `honoless`, and avoid hunting through implementation modules.
- **Small abstractions over raw platform detail:** expose enough AWS shape to stay honest, but keep the authoring layer simpler than raw CloudFormation.
- **Hono first:** route definitions should feel like normal Hono apps, not a custom framework hidden behind decorators or heavy configuration.
- **Bun native:** development, testing, scripts, builds, and file operations should use Bun and `bun test`.
- **Stable local loop:** `dev`, `build`, `synth`, local invoke, and local tests should be boring and reliable before deployment becomes a stable feature.
- **Explicit functions:** invoke types should come from explicit `defineFunction()` definitions, not inferred exported handlers.
- **Migration friendly:** Serverless Framework projects should get maximum automated support, plus precise manual migration reports when behavior cannot be converted safely.
- **Optional local provider:** Floci should be available through a default local adapter, but Voke core should not require Floci as a hard dependency.
- **Predictable AWS output:** generated CloudFormation should be readable, snapshot-testable, and traceable back to the internal model.

## Design Decisions

- Voke should use a small internal infrastructure model first, then synthesize CloudFormation from it.
- `defineConfig()` should be the public normalization point for project, build, local, resource, and CloudFormation settings.
- CLI commands should read `honoless.config.ts` by default and accept flags as narrow overrides, not as a second configuration system.
- Local bootstrap should synthesize from config by default; passing a prebuilt template should remain an escape hatch.
- Resource helpers such as `dynamodbTable()` and `sqsQueue()` should be available from `honoless/aws`.
- Generated starters and migration output should not create `src/stack.ts` unless there is a concrete user need for a custom stack artifact.
- Stable v1 should focus on local/dev/build/synth, not built-in deploy/remove as a stable contract.
- Serverless Framework plugin behavior should be supported as much as possible; unsupported behavior should be reported as manual migration work.
- Invoke types should be generated from explicit function definitions.
- Floci should be an optional local provider with a default adapter.
- AI-native skills and expanded docs/examples should move after the stable foundation.

## Current Baseline

The repository already has early implementations for the core direction:

- Hono API creation and Lambda adapter helpers.
- JSON response helpers, config helpers, and AWS context access.
- `defineConfig()` and `honoless.config.ts` for normalized project/build/CloudFormation configuration.
- CLI commands for `dev`, `build`, `create api`, `synth`, local commands, and migration that can read config by default.
- Config-driven CloudFormation synthesis for Lambda, HTTP API, IAM, environment bindings, outputs, and common AWS resources.
- Resource helpers for DynamoDB, SQS, SNS, EventBridge, S3, Secrets Manager, and Parameter Store, including `honoless/aws` imports.
- Explicit function definitions, a function registry, local invoke, AWS invoke transport hooks, trace metadata, retries, timeouts, and typed registry-scoped invokers.
- Local Floci environment helpers and bootstrap planning that can synthesize from config.
- Serverless Framework migration parsing and skeleton/report generation that should prefer config-first output.
- E2E test helpers and example suites.

The roadmap below turns that baseline into a stable, cleaner, better specified release.

## Phase 1: Stable Public Surface Inventory

Goal: decide what is part of the stable contract and what stays experimental.

- Audit all exports from `voke`.
- Mark each export as stable, internal, or experimental.
- Remove accidental exports from the root entrypoint.
- Decide package subpath exports that should exist long term.
- Treat subpaths as product APIs, especially `honoless/aws` for AWS resource helpers.
- Prefer focused, memorable imports over broad root exports when the domain is clear.
- Add tests that protect the stable export surface.

Deliverables:

- Stable API inventory.
- Root export cleanup.
- Public surface tests.

## Phase 2: Internal Model Shape

Goal: introduce the Voke internal model as the source of truth for synthesis.

- Define model types for service, stage, region, APIs, functions, resources, bindings, outputs, and local providers.
- Keep the model small and serializable.
- Make invalid states hard to represent with TypeScript.
- Keep the model aligned with `defineConfig()` so the public config is not a thin wrapper over a different internal language.
- Add focused model construction tests.
- Keep CloudFormation-specific names out of user-facing model fields where possible.

Deliverables:

- `VokeProjectModel` or equivalent.
- Model builder helpers.
- Model validation tests.

## Phase 3: Config-First API Integration

Goal: make `honoless.config.ts` the normal source of truth for API, build, local, and synth workflows.

- Stabilize the `defineConfig()` shape.
- Load `honoless.config.ts` by default from CLI workflows.
- Map `api()` and `createApiApp()` metadata into the model.
- Preserve current Hono-compatible route authoring.
- Support API name, stage, runtime config, environment variables, and handler metadata.
- Ensure `dev`, `build`, `synth`, and local bootstrap can all run from config without repeated flags.
- Keep route modules and middleware behavior unchanged.
- Add regression tests around current API examples.

Deliverables:

- Stable `defineConfig()` contract.
- API-to-model integration through config.
- Config-loading tests.
- Backward-compatible API tests.
- Updated smoke example where needed.

## Phase 4: Explicit Function Definition Contract

Goal: make function definitions the canonical source for invoke types and function synthesis.

- Tighten `defineFunction()` inputs.
- Require explicit function names and handler contracts.
- Support payload and result typing through definitions.
- Add optional validation hooks without forcing a validation library.
- Add tests for typed registry behavior.

Deliverables:

- Stable function definition API.
- Registry type tests.
- Runtime tests for validation hooks.

## Phase 5: Invoke Runtime Stabilization

Goal: make local and AWS invocation behavior predictable.

- Freeze the invoke request/response contract.
- Standardize sync and async invocation results.
- Clarify retry, timeout, and tracing behavior.
- Keep AWS transport injectable so the AWS SDK is not a core dependency.
- Add error tests for missing functions, invalid payloads, timeout, and failed transport.

Deliverables:

- Stable invoke runtime contract.
- Local invoke test suite.
- Transport error test suite.

## Phase 6: Resource Model

Goal: move resource helpers onto the internal model before CloudFormation synthesis.

- Represent DynamoDB, SQS, SNS, EventBridge, S3, Secrets Manager, and Parameter Store as model resources.
- Expose AWS resource builders from `honoless/aws`.
- Keep resource binding attributes explicit.
- Preserve existing resource helper names where possible.
- Keep resource authoring simple inside `honoless.config.ts`.
- Add validation for resource names and binding attributes.
- Add tests that compare model output instead of only CloudFormation output.

Deliverables:

- Resource model definitions.
- Resource helper migration.
- Resource validation tests.

## Phase 7: Binding Model

Goal: make runtime environment bindings predictable across local and synthesized output.

- Define a stable binding naming convention.
- Generate env bindings from the internal model.
- Support resource value bindings for name, ARN, URL, and ID-like values.
- Ensure local bindings and CloudFormation bindings use the same logical contract.
- Add tests for binding names and values.

Deliverables:

- Binding model.
- Binding naming tests.
- Local/synth binding parity tests.

## Phase 8: CloudFormation Synthesizer V1

Goal: generate CloudFormation from the internal model, not directly from ad hoc options.

- Refactor `synthesizeCloudFormation()` to accept normalized config or build the internal model from it.
- Preserve current generated resources where compatible.
- Make logical ID generation deterministic.
- Keep output readable and snapshot-testable.
- Keep direct template passing available for advanced usage, but make config-driven synthesis the default path.
- Add snapshot tests for minimal API, API with resources, and API with functions.

Deliverables:

- Model-backed CloudFormation synthesizer.
- Snapshot fixtures.
- Migration path for current `synthesizeCloudFormation()` callers.

## Phase 9: CloudFormation Policy Quality

Goal: make generated IAM reasonable enough for stable use.

- Generate least-practical policies from declared resources.
- Avoid empty or invalid IAM statements.
- Cover resource-specific ARN shapes.
- Add tests for each supported resource helper.
- Document any intentionally broad permissions near the code.

Deliverables:

- IAM policy generation tests.
- Resource-specific policy coverage.
- Cleaner synthesized templates.

## Phase 10: Build Pipeline

Goal: make `voke build` produce predictable Bun output.

- Define build inputs and output directory conventions in `defineConfig()`.
- Preserve Bun-first behavior.
- Ensure handler output aligns with synthesized Lambda metadata.
- Allow CLI flags to override config for one-off runs without creating a parallel config system.
- Add tests for CLI build command construction where practical.
- Add an example build fixture.

Deliverables:

- Stable build command behavior.
- Build output conventions.
- Build fixture tests.

## Phase 11: Dev Runtime

Goal: make `voke dev` reliable for local API development.

- Define the dev entrypoint contract through config first.
- Keep hot reload Bun-native.
- Add clear errors for missing entrypoints.
- Support local environment bindings in dev mode.
- Avoid requiring users to repeat entrypoint/stage/region flags already present in config.
- Add tests for dev command behavior with injected runners where possible.

Deliverables:

- Stable dev command behavior.
- Local environment loading.
- Dev command tests.

## Phase 12: CLI Contract

Goal: make the stable CLI predictable and small.

- Keep stable commands focused on `dev`, `build`, `create api`, `synth`, `local`, and `migrate serverless`.
- Read `honoless.config.ts` by default where project context is needed.
- Treat flags as explicit overrides, not the primary configuration path.
- Mark `deploy` and `remove` experimental or move them behind an explicit experimental path.
- Standardize flag parsing, usage errors, and exit behavior.
- Add command-level tests for happy paths and invalid input.
- Keep all file operations Bun-native.

Deliverables:

- Stable CLI command matrix.
- CLI usage tests.
- Experimental deploy/remove decision reflected in code.

## Phase 13: Local Provider Interface

Goal: make local AWS support provider-based instead of hard-coded.

- Define a local provider interface for environment, compose/config, bootstrap, reset, and endpoints.
- Keep Floci as the default adapter.
- Allow custom providers without changing core runtime code.
- Avoid requiring Floci-specific dependencies in core.
- Add provider contract tests.

Deliverables:

- Local provider interface.
- Default Floci adapter.
- Provider contract tests.

## Phase 14: Floci Adapter Stabilization

Goal: make the default local provider reliable while keeping it optional.

- Keep Floci config generation small and explicit.
- Generate stable endpoint and credential environment values.
- Support local bootstrap plans from config by default and templates as an escape hatch.
- Add tests for compose config, env config, bindings, and bootstrap commands.
- Make failures actionable when Docker or Floci is unavailable.

Deliverables:

- Stable Floci adapter behavior.
- Local bootstrap tests.
- Clear local error messages.

## Phase 15: Local API and Invoke Parity

Goal: make local execution match the stable API/function model.

- Ensure local API tests use Lambda/API Gateway semantics.
- Ensure local invoke routes through explicit function definitions.
- Propagate tracing metadata consistently.
- Add cross-function E2E tests.
- Add tests for local resource bindings in API and function code.

Deliverables:

- API local parity tests.
- Invoke local parity tests.
- Cross-function example verification.

## Phase 16: E2E Test Harness

Goal: make integration testing a first-class stable workflow.

- Stabilize `createTestClient()`.
- Stabilize `createInvokeTestClient()`.
- Stabilize `createStackTestContext()`.
- Support local and deployed smoke target shapes without making deploy stable.
- Add deterministic examples that run with `bun test`.

Deliverables:

- Stable E2E helper API.
- E2E tests for API, invoke, local resources, and stack outputs.
- Minimal E2E example.

## Phase 17: Serverless Parser Coverage

Goal: parse common Serverless Framework services accurately.

- Improve parsing for service, provider, functions, events, environment, IAM, package rules, layers, and custom fields.
- Support HTTP API, REST API, SQS, SNS, EventBridge, S3, schedule, and stream-like event declarations where possible.
- Add fixture tests for common YAML shapes.
- Preserve unknown fields in the migration report.
- Keep parser behavior deterministic and dependency-light.

Deliverables:

- Expanded parser fixtures.
- Event coverage matrix.
- Unknown-field reporting.

## Phase 18: Serverless Plugin Migration Coverage

Goal: support as much plugin behavior as possible without pretending unsafe conversions are automatic.

- Catalog common Serverless Framework plugins.
- Map plugin behavior into Voke model features where safe.
- Generate manual migration tasks for unsupported plugin behavior.
- Add compatibility notes for each detected plugin.
- Add tests for plugin detection and report output.

Deliverables:

- Plugin compatibility matrix.
- Plugin report tests.
- Migration report sections for manual work.

## Phase 19: Serverless Skeleton Generation

Goal: make generated migrations useful as a starting point.

- Generate API route skeletons from HTTP and REST events.
- Generate explicit function definitions for workers.
- Generate `honoless.config.ts` with resource declarations where possible.
- Generate package scripts using Bun.
- Avoid generating `src/stack.ts` unless a custom stack artifact is genuinely needed.
- Add tests against example Serverless projects.

Deliverables:

- Generated Voke project skeleton.
- Config-first migrated project.
- Function skeleton generation.
- Example migration fixtures.

## Phase 20: Migration Report Quality

Goal: make migration output honest, complete, and easy to act on.

- Include converted behavior, unsupported behavior, manual tasks, plugin notes, and confidence levels.
- Point to generated files from the report.
- Group manual work by risk and feature area.
- Add report snapshot tests.
- Avoid vague "unsupported" messages when a concrete reason is known.

Deliverables:

- Stable `MIGRATION_REPORT.md` format.
- Stable `SERVERLESS_COMPATIBILITY.md` format.
- Snapshot tests for report output.

## Phase 21: Project Creation

Goal: make `voke create api` create a stable, testable project.

- Generate a minimal Hono API.
- Generate `honoless.config.ts` as the project source of truth.
- Generate one route module and one test.
- Generate Bun scripts for dev, build, synth, test, and typecheck.
- Use config-driven local/build/synth APIs in the generated starter.
- Avoid generated glue files that only call framework APIs with duplicated config.
- Add tests for generated file contents.

Deliverables:

- Stable project template.
- Create command tests.
- Starter smoke test.

## Phase 22: Error Design

Goal: make errors clear for application developers and migration users.

- Standardize framework error types.
- Improve validation errors for bad model input.
- Improve CLI usage errors.
- Improve migration unsupported-feature messages.
- Add tests for error messages on public workflows.

Deliverables:

- Error conventions.
- Public error tests.
- Cleaner CLI and migration failures.

## Phase 23: TypeScript Quality Gate

Goal: make TypeScript types part of the stable product.

- Tighten public generics for APIs, functions, registries, and invoke.
- Add type-level tests where useful.
- Run `bun run typecheck` as a required release gate.
- Avoid `any` in public contracts unless there is a deliberate escape hatch.
- Make internal model types readable for users who inspect them.

Deliverables:

- Type quality cleanup.
- Type regression tests.
- Passing typecheck.

## Phase 24: Test Coverage and Regression Suite

Goal: protect the stable contract with focused tests.

- Add regression tests for API adapter behavior.
- Add regression tests for CloudFormation synthesis.
- Add regression tests for local provider behavior.
- Add regression tests for invoke behavior.
- Add migration fixture tests for Serverless Framework inputs.
- Keep tests fast enough for normal development.

Deliverables:

- Stable regression suite.
- `bun test` release gate.
- Reduced reliance on manual smoke testing.

## Phase 25: Examples for Stable Smoke Coverage

Goal: keep examples small and useful without turning docs/examples into the main workstream.

- Maintain `hello-api`.
- Maintain `cross-function`.
- Maintain one E2E example.
- Maintain Serverless migration fixtures.
- Keep examples tied to tests so they do not drift.

Deliverables:

- Stable smoke examples.
- Example tests.
- No large example catalog yet.

## Phase 26: Minimal Reference Docs

Goal: document only what stable users need to adopt the first release.

- Update README for stable scope.
- Document `honoless.config.ts` and `defineConfig()` as the core DX pattern.
- Document the internal model concept at a high level, without making users author it directly.
- Document domain subpaths such as `honoless/aws`.
- Document `dev`, `build`, `synth`, `local`, `invoke`, and migration workflows.
- Clearly mark deployment as experimental or out of stable scope.
- Keep docs short and example-driven.

Deliverables:

- README stable refresh.
- Minimal migration guide refresh.
- Minimal E2E guide refresh.

## Phase 27: Release Packaging

Goal: make the package installable and predictable.

- Verify package exports.
- Verify CLI bin behavior.
- Build package output with Bun.
- Check package contents before publishing.
- Add release checklist.

Deliverables:

- Package build verification.
- Publish dry-run or equivalent package inspection.
- Release checklist.

## Phase 28: Stable Release Candidate

Goal: validate the whole stable workflow from a clean project.

- Create a fresh Voke API.
- Run local dev smoke checks.
- Build the API.
- Synthesize CloudFormation.
- Run API, invoke, and migration tests.
- Run typecheck.
- Fix release-blocking issues only.

Deliverables:

- Stable release candidate.
- Release verification log.
- Known limitations list.

## Post-Stable: Deployment

Goal: decide and implement the deployment story after the stable local/build/synth contract is proven.

- Revisit built-in `deploy` and `remove`.
- Decide whether deployment should wrap AWS CLI, use AWS SDK clients, or remain external.
- Add diff, rollback guidance, and deployment smoke tests if built in.
- Keep deployment separate from stable local/build/synth until the contract is clear.

## Post-Stable: AI-Native Skills

Goal: add agent workflows after the framework has stable conventions.

- Create Voke API development skill.
- Create Serverless migration skill.
- Create E2E testing skill.
- Create CloudFormation review skill.
- Add validation scripts for skills.

## Post-Stable: Expanded Documentation and Examples

Goal: teach the framework broadly after the stable core stops moving.

- Expand quickstart docs.
- Add local development docs.
- Add invoke docs.
- Add CloudFormation docs.
- Add migration docs.
- Add production-style examples.

## Near-Term Milestones

1. Stabilize `honoless.config.ts` and `defineConfig()` as the single configuration path.
2. Make `dev`, `build`, `synth`, and `local bootstrap` config-driven by default.
3. Keep AWS resource authoring under `honoless/aws` and protect that subpath with tests.
4. Introduce the internal model only where it simplifies the public API or generated output.
5. Stabilize explicit function definitions and invoke types.
6. Make Floci the default local provider through an optional provider interface.
7. Remove generated or documented glue files that duplicate config, especially stack-only files.
8. Mark deployment commands experimental or move them out of the stable path.
9. Expand Serverless Framework migration coverage and plugin reporting using config-first output.
10. Lock down CLI behavior for `dev`, `build`, `synth`, `local`, and `migrate`.
11. Build the stable regression suite around API, invoke, local, synth, config loading, subpath exports, and migration.
12. Refresh README only after the stable DX decisions are reflected in code.
