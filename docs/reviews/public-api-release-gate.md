# Public API Release Gate Review

Date: 2026-05-24

Scope: final release-gate review for the pre-release Voke public API redesign across issues #26 and #27.

## Root exports

The stable root package is intentionally limited to the common authoring path:

- `createFunctions`
- `defineConfig`
- `fn`
- `http`
- `route`
- `voke`

Specialized helpers stay in explicit packages: `@voke/aws`, `@voke/aws/cloudformation`, `@voke/aws/local`, `@voke/aws/testing`, `@voke/build`, `@voke/http`, `@voke/remote`, `@voke/schema`, and `@voke/testing`.

## Drift review

- `voke create api` generates the canonical `defineConfig({ name })`, `createFunctions`, `http`, `route`, and `voke(functions)` starter shape.
- First-party examples use the new authoring names and subpaths for response, schema, testing, local, and AWS helpers.
- README and docs now position Voke as a TypeScript-first AWS Lambda framework. Bun remains tooling/runtime detail, not the product headline.
- Hono appears only as compatibility/runtime detail or in lower-level compatibility tests, not as the default authoring model.
- Serverless migration output generates `createFunctions`, `fn`, `http`, `route`, `sqs`, and `voke(functions, { config })`.
- Remaining removed names are either compatibility internals (`packages/core/src/app.ts`, `packages/core/src/invoke.ts`), explicit negative release-gate assertions, or historical ADR/review context.

## Verification

- `bun test packages/core/test/serverless-migration.test.ts packages/core/test/public-surface.test.ts`
- `bun run check`
- `bun run typecheck`
- `bun test`
- `bun run --filter @voke/docs build`

The parent PRD issue should remain open unless the maintainer explicitly closes it.
