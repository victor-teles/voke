# Deploy through a Provider Capability

`voke deploy` and `voke remove` are top-level commands that work through the configured **Provider**. Core adds a provider-neutral `ProviderDeployCapability { deploy, remove }` to the Provider contract; `@vokejs/aws` implements it with the AWS SDK (CloudFormation and S3), so core stays free of AWS concepts and a second Provider would implement the same capability.

The CLI owns what is the same for every Provider: resolving the stage (`--stage`, then `VOKE_STAGE`, then config), refusing the `local` stage unless a local endpoint is configured, running the Provider build plan, asking for confirmation before `remove`, printing outputs with `ApiUrl` first, and writing `.voke/outputs/<stage>.json`. The Provider owns packaging, uploads, stack changes and their progress. A neutral `VokeDeployError` (code `DEPLOY_ERROR`) carries Provider failures, and `VokeError` is exported so Providers can throw typed errors.

The AWS Provider deploys without the AWS CLI. It zips the build output deterministically and names the artifact by its content hash, so an unchanged build uploads nothing. Artifacts and templates live in one private, encrypted bucket created by a `voke-bootstrap` stack per account and region. Templates are uploaded and referenced by URL, which lifts the inline template size limit. Changes go through CloudFormation change sets: a `--dry-run` describes and deletes the change set without executing it, and an empty change set reports "No changes".

HTTP APIs use the `$default` stage. One stack per Voke stage already isolates environments, and a named stage would put its name in both the URL and `rawPath`, so Gateway routes would not match. The AWS SDK clients for deploy are loaded only when deploy or remove runs, and `build.external` keeps them out of Lambda bundles.

The trade-off is a bootstrap stack and bucket that Voke creates on first deploy, and a deploying identity that needs CloudFormation, S3, IAM, Lambda and API Gateway permissions. The artifact bucket grows with each distinct build; a lifecycle rule must not expire objects younger than the oldest stack that may roll back.
