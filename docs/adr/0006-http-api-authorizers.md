# Support named HTTP API authorizers

Voke will support AWS API Gateway HTTP API v2 authorizers through a named Authorizer Registry that can provide a Default HTTP Authorizer and route-level overrides. The v1 authorizer surface includes JWT Authorizers and Lambda Authorizers, where Lambda Authorizers can target a local Request Authorizer Function by registry key or an already deployed Lambda by name or ARN; remote Voke Function targets are deferred until deployed remote invocation is settled.

Authorizer configuration is registry-based rather than inline because API Gateway authorizers are API-level resources that may be shared by many routes and need stable names during model and CloudFormation synthesis. A route with no authorizer setting inherits the default when one exists, while `authorizer: "none"` is the explicit public-route override; merely registering an authorizer does not protect any route. Local Authorizer Evaluation runs Request Authorizer Functions, allows injected Route Auth Context for tests, and does not fully validate JWTs by default.

The common authoring helpers `createAuthorizers`, `jwtAuthorizer`, `lambdaAuthorizer`, and `requestAuthorizer` belong on the root package export because authorizers are part of first-party HTTP Function authoring rather than a low-level provider escape hatch.

Authorizer registries and default authorizer choices are declared on `http(...)` Function entrypoints rather than on `voke(functions, ...)` because authorization is part of the HTTP API model that should synthesize from the Function Registry alongside routes and event sources.

A default authorizer applies only to the routes of the `http(...)` Function entrypoint that declares it, while authorizer names remain scoped to the whole synthesized HTTP API. This lets separate route-backed Functions choose different defaults without duplicating API-level authorizer resources.

Route-level authorizer overrides in v1 can reference only the authorizers declared on their own `http(...)` Function entrypoint, plus the explicit `"none"` public-route override. Cross-entrypoint reuse should happen by importing and passing the same Authorizer Registry value into each `http(...)` declaration instead of reaching across Function entrypoint boundaries.

Request Authorizer Functions are distinct Function entrypoints but remain first-class deployable Functions: they can use resource bindings and synthesis configuration while not mixing HTTP routes, Event Sources, or invokable handlers. Lambda Authorizers expose an explicit `cacheTtlSeconds` option that defaults to `0` so authorization caching is opt-in.

Voke synthesizes API Gateway invoke permission automatically for Lambda Authorizers that target a local Request Authorizer Function created by the same stack. Deployed Lambda name or ARN targets are external to the stack's Function Registry and must already allow API Gateway invocation in v1.

External Lambda Authorizer targets may be provided as either deployed Lambda names or Lambda ARNs, with ARNs preferred because they make account and region ownership explicit.

Lambda Authorizers use HTTP API authorizer payload format version `2.0` with simple responses enabled. Voke does not support v1 policy-document authorizer responses in this design because Request Authorizer Functions return Voke-level Authorizer Results rather than raw IAM policies.
