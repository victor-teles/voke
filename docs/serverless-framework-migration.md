# Serverless Framework Migration

Voke can generate an incremental migration skeleton from a `serverless.yml` service.

```bash
voke migrate serverless ./serverless.yml --out ./voke-migration
```

The command writes a small Voke project with:

- `src/index.ts` for generated Hono routes.
- `src/routes/*.ts` for HTTP API and REST API events.
- `src/functions/*.ts` for SQS and EventBridge worker skeletons.
- `voke.config.ts` for app, build, and CloudFormation synthesis settings.
- `MIGRATION_REPORT.md` for supported features, unsupported features, and manual steps.
- `SERVERLESS_COMPATIBILITY.md` for the compatibility matrix detected during migration.

## Incremental Strategy

Move one function at a time:

1. Run the migrator into a new directory.
2. Pick one generated route or worker.
3. Move the real handler logic into the generated Voke file.
4. Route traffic for that path or event to Voke.
5. Keep the remaining Serverless Framework functions in place until each one has been verified.

## Compatibility Matrix

| Serverless Framework pattern       | Migration status   | Voke output                                   |
| ---------------------------------- | ------------------ | --------------------------------------------- |
| `service`                          | Supported          | App and package names.                        |
| `provider.stage`                   | Supported          | App config and stack stage.                   |
| `provider.region`                  | Supported          | App config and stack region.                  |
| `provider.environment`             | Supported          | Stack environment starter.                    |
| `provider.iamRoleStatements`       | Reported           | Manual CloudFormation review item.            |
| `package.patterns`                 | Reported           | Manual Bun build review item.                 |
| `plugins`                          | Reported           | Unsupported plugins are listed in the report. |
| `functions.*.events[].httpApi`     | Supported          | Hono route skeleton.                          |
| `functions.*.events[].http`        | Supported          | Hono route skeleton.                          |
| `functions.*.events[].sqs`         | Supported skeleton | Voke function skeleton.                       |
| `functions.*.events[].eventBridge` | Supported skeleton | Voke function skeleton.                       |
| Other events                       | Manual migration   | Unsupported event report item.                |

## Notes

The YAML parser is intentionally small and dependency-free. It supports the common Serverless Framework shapes Voke migrates today: nested maps, lists, scalars, provider config, function events, IAM statements, package patterns, and plugins. Complex YAML anchors, custom tags, and plugin-specific config should be treated as manual migration inputs.
