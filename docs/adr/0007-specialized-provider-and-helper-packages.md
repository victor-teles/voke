# Split provider and helper ownership into specialized packages

Voke will keep `voke` as the product-facing core authoring package while moving provider-specific and specialized helper surfaces to explicit packages. The core package owns provider-neutral Function, Gateway, config, contract, route, and Provider capability contracts; `@voke/aws` depends on public `voke` and owns the full AWS workflow, including AWS runtime adapters, resource helpers, SQS and authorizer entrypoints, local AWS workflow helpers, and CloudFormation synthesis under `@voke/aws/cloudformation`.

This supersedes the earlier assumption that core should depend directly on AWS SDK Lambda transport, that specialized helpers should live on `voke/*` subpaths, and that API Gateway authorizers should be root exports. Specialized non-provider helpers belong to packages such as `@voke/schema`, `@voke/http`, `@voke/testing`, `@voke/remote`, and `@voke/build`; provider-specific data appears in the provider-neutral model through Provider Extension Records that each Provider validates and interprets.

The trade-off is that new projects install more packages, but the starter remains batteries-included and authoring boundaries become explicit. This keeps future providers possible without making root `voke` depend on AWS, CloudFormation, SQS, or API Gateway concepts.
