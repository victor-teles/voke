# Runtime Variables and AWS export boundaries

Voke will support per-Function Runtime Variables for provider-backed values loaded from deployed secret and parameter sources at runtime. Runtime Variables are declared through a `variables` catalog on each deployable Function kind, are read from handler context through value handles, cache within a warm Function runtime by default, and can opt out of caching or define an explicit cache duration.

Runtime Variables are Function implementation dependencies, not Function Contracts, so they must not appear in Function Contract Artifacts or generated remote clients. Keeping them per-Function lets Voke synthesize least-privilege IAM for only the Functions that declare each secret or parameter, while local and test execution can resolve them from explicit overrides and environment variables before using real AWS sources.

The `voke/aws` subpath will become the runtime AWS helper surface, including `secret`, `parameter`, `bindResource`, and `createAwsClientConfig`. CloudFormation resource builders such as `dynamodbTable`, `sqsQueue`, `secret`, and `ssmParameter` move to `voke/cloudformation` so runtime value loading and infrastructure declaration do not share the same import boundary.

Because Voke is still pre-stable, this export-boundary change should be a clean break rather than a deprecated alias period. After the move, `secret` and `parameter` from `voke/aws` are runtime variable builders only.

Runtime Variables support provider plugins, with AWS Secrets Manager and SSM Parameter Store as the first-party initial provider implementation. Provider extension must preserve the same Function-scoped declaration, local override, cache, and contract-exclusion rules as the first-party AWS provider.

Runtime Variable providers own provider-specific source descriptors, value loading, redacted source labels, and optional deployment synthesis contributions such as IAM policy fragments. Voke owns per-Function declarations, `context.variables` typing, local and test overrides, environment fallback, caching, in-flight load deduplication, value handles, optional behavior, redacted error envelopes, and Function Contract exclusion.

Runtime Variable declarations distinguish external AWS names from Voke-managed resource keys at the callsite. Direct builder calls reference external AWS names, while resource-key references use a separate form such as `secret.fromResource("signingSecret")` or `parameter.fromResource("publicConfig")`.
