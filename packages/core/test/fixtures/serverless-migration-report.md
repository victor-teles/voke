# Serverless Framework Migration Report

## Summary

| Metric             | Value        |
| ------------------ | ------------ |
| Service            | `orders-api` |
| Generated files    | 9            |
| Converted behavior | 8            |
| Manual tasks       | 7            |
| Unknown fields     | 0            |

## Generated files

| Path                                           | Purpose                                                  | Confidence |
| ---------------------------------------------- | -------------------------------------------------------- | ---------- |
| `./voke-orders/package.json`                   | Bun-first project scripts and dependencies.              | high       |
| `./voke-orders/tsconfig.json`                  | TypeScript project configuration.                        | high       |
| `./voke-orders/voke.config.ts`                 | Config-first Voke application and resource declarations. | high       |
| `./voke-orders/src/index.ts`                   | Generated Function-first Gateway entrypoint.             | high       |
| `./voke-orders/MIGRATION_REPORT.md`            | Actionable migration report.                             | high       |
| `./voke-orders/SERVERLESS_COMPATIBILITY.md`    | Stable compatibility matrix.                             | high       |
| `./voke-orders/src/functions/index.ts`         | Generated worker Function Registry.                      | high       |
| `./voke-orders/src/routes/list-orders.ts`      | Route skeleton for listOrders.                           | high       |
| `./voke-orders/src/functions/fulfill-order.ts` | Worker function skeleton for fulfillOrder.               | medium     |

## Converted behavior

| Area    | Behavior                                                                                                                                                                                                              | Generated output                               | Confidence |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------- |
| Routing | Service orders-api is represented as a Voke config-first project.                                                                                                                                                     | `./voke-orders/voke.config.ts`                 | high       |
| Routing | Provider stage and region are represented in Voke config.                                                                                                                                                             | `./voke-orders/voke.config.ts`                 | high       |
| Build   | Provider environment variables are copied into CloudFormation environment settings.                                                                                                                                   | `./voke-orders/voke.config.ts`                 | medium     |
| Routing | HTTP API route GET /orders is generated for listOrders.                                                                                                                                                               | `./voke-orders/src/routes/list-orders.ts`      | high       |
| Routing | REST API route POST /orders is generated for listOrders.                                                                                                                                                              | `./voke-orders/src/routes/list-orders.ts`      | high       |
| Events  | EventBridge worker skeleton is generated for fulfillOrder.                                                                                                                                                            | `./voke-orders/src/functions/fulfill-order.ts` | medium     |
| Plugins | Plugin serverless-offline is supported: Local development workflow is covered by Voke dev/local commands. Reason: Use `voke dev` for local API feedback and `voke local start` for the configured local AWS provider. | `./voke-orders/SERVERLESS_COMPATIBILITY.md`    | high       |
| Plugins | Plugin serverless-webpack is mapped: Build behavior maps to the Voke Bun build pipeline. Reason: Generated projects use `voke build`, which bundles with Bun.                                                         | `./voke-orders/SERVERLESS_COMPATIBILITY.md`    | medium     |

## Manual work by risk

### High risk

| Area | Task                                                                                                                                  | Reason                                                                                         | Generated output | Confidence |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------- | ---------- |
| IAM  | Review provider IAM statements and translate required permissions into Voke resource bindings or CloudFormation policy configuration. | IAM statements can be security-sensitive and are reported rather than rewritten automatically. | -                | high       |

### Medium risk

| Area    | Task                                                                                                                                      | Reason                                                                                             | Generated output                            | Confidence |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------- |
| Routing | Review generated route and worker handlers before deleting the matching Serverless Framework function.                                    | Generated skeletons are starter code and do not migrate business logic.                            | -                                           | high       |
| Build   | Review Serverless package patterns against the generated Bun build workflow.                                                              | Voke builds with Bun and does not execute Serverless packaging filters.                            | `./voke-orders/package.json`                | medium     |
| Build   | Review `custom.webpack` options and port any required aliases, loaders, externals, or minification settings into the Voke build workflow. | serverless-webpack: Build behavior maps to the Voke Bun build pipeline.                            | `./voke-orders/SERVERLESS_COMPATIBILITY.md` | medium     |
| Events  | sqs event on fulfillOrder requires manual implementation.                                                                                 | Queue source cannot be resolved to a migrated Voke SQS queue resource.                             | -                                           | high       |
| Events  | schedule event on scheduledReport requires manual implementation.                                                                         | Scheduled triggers require EventBridge rule infrastructure that must be reviewed before migration. | -                                           | high       |

### Low risk

| Area    | Task                                                                                                                                    | Reason                                                                      | Generated output             | Confidence |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------- | ---------- |
| Routing | Move one Serverless function at a time by routing migrated HTTP paths to Voke while the original service keeps the remaining functions. | This keeps the migration reversible while generated skeletons are reviewed. | `./voke-orders/src/index.ts` | high       |

## Plugin notes

| Plugin               | Status    | Notes                                                                                                                                                                                                                | Manual work                                                                                                                               |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `serverless-offline` | supported | Voke does not run the Serverless Offline plugin, but the stable local workflow covers the same development loop. Use `voke dev` for local API feedback and `voke local start` for the configured local AWS provider. | -                                                                                                                                         |
| `serverless-webpack` | mapped    | Voke uses Bun for builds, so Webpack plugin execution is not carried forward. Generated projects use `voke build`, which bundles with Bun.                                                                           | Review `custom.webpack` options and port any required aliases, loaders, externals, or minification settings into the Voke build workflow. |

## Unknown fields

- No unknown fields detected.

## Compatibility projections

### Supported features

- service name
- provider stage
- provider region
- provider environment
- provider IAM statements
- package patterns
- plugins inventory
- HTTP API event: listOrders GET /orders
- REST API event: listOrders POST /orders
- EventBridge event: fulfillOrder
- Schedule event inventory: scheduledReport

### Unsupported features

- plugin serverless-webpack maps to Voke Bun build but requires bundler option review
- sqs event on fulfillOrder requires manual implementation. Queue source cannot be resolved to a migrated Voke SQS queue resource.
- schedule event on scheduledReport requires manual implementation. Scheduled triggers require EventBridge rule infrastructure that must be reviewed before migration.

### Manual steps

- Move one Serverless function at a time by routing migrated HTTP paths to Voke while the original service keeps the remaining functions.
- Review generated route and worker handlers before deleting the matching Serverless Framework function.
- Review provider IAM statements and translate required permissions into Voke resource bindings or CloudFormation policy configuration.
- Review Serverless package patterns against the generated Bun build workflow.
- Review `custom.webpack` options and port any required aliases, loaders, externals, or minification settings into the Voke build workflow.
- sqs event on fulfillOrder requires manual implementation.
- schedule event on scheduledReport requires manual implementation.

## Function inventory

- listOrders: src/functions/list-orders.handler (httpApi, http)
- fulfillOrder: src/functions/fulfill-order.handler (sqs, eventBridge)
- scheduledReport: src/functions/scheduled-report.handler (schedule)

## Event inventory

- `listOrders.events[0].httpApi`

```json
{
  "method": "get",
  "path": "/orders"
}
```

- `listOrders.events[1].http`

```json
{
  "method": "post",
  "path": "/orders"
}
```

- `fulfillOrder.events[0].sqs`

```json
{
  "arn": "arn:aws:sqs:sa-east-1:123456789012:orders"
}
```

- `fulfillOrder.events[1].eventBridge`

```json
{
  "eventBus": "orders",
  "pattern": {
    "source": ["orders"]
  }
}
```

- `scheduledReport.events[0].schedule`

```json
"rate(1 day)"
```
