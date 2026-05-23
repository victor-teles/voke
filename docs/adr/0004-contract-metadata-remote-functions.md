# Use contract metadata and generated Remote Function Registries for local cross-project invocation

Voke will support local cross-project Function invocation through portable contract metadata and generated Remote Function Registries instead of requiring one project to import another project's Function implementation. Provider code can live in a different repository, so the shared boundary must be an implementation-free Function Contract Artifact, not a source import.

The canonical Function Contract Artifact is JSON-schema-like metadata exposed by the provider at runtime, including the provider project name, public Function contracts, and a stable fingerprint of that contract surface. This makes the metadata fetchable by other services and suitable for code generation across repository and language boundaries.

Consuming projects use explicit Remote Code Generation before runtime. `voke remote generate` fetches provider contract metadata for every configured remote by default, while `voke remote generate <name>` limits generation to one remote. Generated modules are checked into the consuming project, default to `src/voke/remotes/<remote>.ts`, are marked as generated, and export ready-to-import Remote Function Registries created with `defineRemoteFunctions`.

Runtime targets for remotes live in the consuming project's `voke.config.ts`, keyed by provider project name and selected by stage. A remote contract metadata URL is optional when it can be derived from the selected target plus `/_voke/contract`; explicit metadata locations remain available for projects that publish contracts elsewhere. Invocation callsites should import generated Remote Function Registries and invoke by Function key without repeating origins or transport details.

The first implementation slice is local `voke dev` to local `voke dev` invocation. Provider `voke dev` exposes Voke-owned metadata at `/_voke/contract` and a reserved Dev Function Invoke Endpoint for internal Function invocation. This endpoint is separate from user-defined HTTP routes so internal Functions can be invoked across projects without becoming public routes. Voke-managed tokens are deferred from v1.

Remote invocation sends the generated contract fingerprint with the request when the provider can validate it. If the provider's current contract fingerprint differs, invocation should fail clearly and tell the consuming project to regenerate remote code. This avoids silently executing against stale generated types when contracts drift across repositories.

Deployed cross-project invocation is intentionally deferred, but the stage-aware remote target model leaves room for later AWS or hosted transports without changing the authoring vocabulary.
