# Serverless Framework Migration

Voke can generate an incremental migration skeleton from a `serverless.yml` service.

```bash
voke migrate serverless ./serverless.yml --out ./voke-migration
```

The command writes a small Voke project with:

- `src/index.ts` for a generated Function-first Gateway.
- `src/routes/*.ts` for Route Builder declarations from HTTP API and REST API events.
- `src/functions/*.ts` for SQS Event Source Functions and EventBridge worker skeletons.
- `src/functions/index.ts` for the generated Function Registry when workers exist.
- `voke.config.ts` for app, build, and CloudFormation synthesis settings.
- `MIGRATION_REPORT.md` for generated files, converted behavior, manual work grouped by risk, plugin notes, unknown fields, and compatibility projections.
- `SERVERLESS_COMPATIBILITY.md` for the compatibility matrix with status, confidence, generated output, and manual work.

## Report Quality

The migration reports are intentionally stable and action-oriented:

- Confidence is reported as `high`, `medium`, or `low` so teams can separate safe config conversions from starter skeletons that still need review.
- Generated files are listed with exact paths, including routes, worker Functions, the Function Registry, `voke.config.ts`, and both report files.
- Manual work is grouped by risk (`high`, `medium`, `low`) and feature area (`events`, `plugins`, `resources`, `iam`, `build`, `routing`, and `unknown-fields`).
- Unsupported behavior includes concrete reasons when Voke knows why the behavior cannot be generated safely.

## Incremental Strategy

Move one function at a time:

1. Run the migrator into a new directory.
2. Pick one generated route or worker.
3. Move the real handler logic into the generated Function or Route Builder file.
4. Route traffic for that path or event to Voke.
5. Keep the remaining Serverless Framework functions in place until each one has been verified.

## Compatibility Matrix

| Serverless Framework pattern       | Migration status                                                   | Voke output                                                        |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `service`                          | Supported                                                          | App and package names.                                             |
| `provider.stage`                   | Supported                                                          | App config and stack stage.                                        |
| `provider.region`                  | Supported                                                          | App config and stack region.                                       |
| `provider.environment`             | Supported                                                          | Stack environment starter.                                         |
| `provider.iamRoleStatements`       | Reported                                                           | Manual CloudFormation review item.                                 |
| `package.patterns`                 | Reported                                                           | Manual Bun build review item.                                      |
| `plugins`                          | Reported                                                           | Unsupported plugins are listed in the report.                      |
| `functions.*.events[].httpApi`     | Supported                                                          | Route Builder skeleton mounted in a Gateway.                       |
| `functions.*.events[].http`        | Supported                                                          | Route Builder skeleton mounted in a Gateway.                       |
| `functions.*.events[].sqs`         | Supported when the queue maps to a generated `sqsQueue()` resource | SQS Event Source Function with `sqs({ message, queue, handler })`. |
| `functions.*.events[].eventBridge` | Supported skeleton                                                 | Voke Function skeleton.                                            |
| Native CloudFormation resources    | Supported skeleton                                                 | Config-first `voke.config.ts` declarations.                        |
| Other events                       | Manual migration                                                   | Unsupported event report item.                                     |
| Unsafe custom resources            | Manual migration                                                   | Manual step with the concrete resource type.                       |

## Notes

The YAML parser is intentionally small and dependency-free. It supports the common Serverless Framework shapes Voke migrates today: nested maps, lists, scalars, provider config, function events, IAM statements, package patterns, plugins, and safe native CloudFormation resource declarations. Complex YAML anchors, custom tags, unsupported resource properties, and plugin-specific config should be treated as manual migration inputs.
