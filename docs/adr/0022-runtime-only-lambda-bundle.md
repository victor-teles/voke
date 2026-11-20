# The Lambda Bundle holds run-time code only, through the `voke-runtime` condition

`voke build` writes one **Lambda Bundle** that every Function loads at cold start. The user's `voke.config.ts` is part of it, because a deployed Function needs `config.plugins`, `config.api` and three members of `config.provider`: `runtime.variables`, `runtime.routeAuth` and `invoke`. The config also has `import { aws } from "@vokejs/aws"`, and `aws()` returned an object that referenced every Provider Capability, so the bundle carried CloudFormation synthesis, deploy, the zip writer, the `voke local` workflow, the AWS Emulator client and the build planner. For `examples/hello-api` that was about 30% of a 300 KB file, parsed on every cold start and uploaded on every deploy.

## Decision

A package separates its run-time code from its deploy-time code with the package condition `voke-runtime`. `@vokejs/build` passes `--conditions voke-runtime` to every bundle it plans, for every Provider. All other consumers (the CLI, `voke dev`, tests, the type checker) resolve the `default` target.

`@vokejs/aws` applies it with a package `imports` entry:

```json
"imports": {
  "#provider": {
    "voke-runtime": "./src/provider-runtime.ts",
    "default": "./src/provider.ts"
  }
}
```

Its `index.ts` exports `aws` from `"#provider"`, so the user still writes `import { aws } from "@vokejs/aws"`, the package keeps one export list, and the condition also applies when `@vokejs/aws` is reached through tsconfig `paths`, as core's tests do. The run-time `aws()` returns `invoke`, `name` and `runtime` only and ignores its options; `voke build` and `voke deploy` already validated them with the full `aws()`, which spreads the same run-time object and adds the deploy-time capabilities. The Event Source adapters are split the same way: a run-time adapter (`toInvocation`, `toResponse`) that the Lambda handlers read, and a deploy adapter (validation and synthesis), both in the Event Source's own file.

The bundle is built with `--minify-whitespace --minify-syntax` and never `--minify-identifiers`. Function and class names stay as written, so a CloudWatch stack frame reads `at chargeCard (file:///var/task/index.js:1:51234)`; the position is a column on one of a few long lines. There is no setting for minification.

The bundle has no source map and there is no setting for one. Node applies a map only with `--enable-source-maps`, which slows every error path; the map is several times the size of the bundle and would have to be uploaded too. Kept identifiers cover the common need.

`examples/hello-api/test/bundle.test.ts` builds the bundle through the AWS Provider's build plan and fails when a listed deploy-time module contributes bytes, when a deploy-time marker string appears, or when the bundle passes a size budget set from a measurement.

## Considered options

- **Load the deploy capabilities with dynamic `import()`.** It removes nothing: `bun build --target node --format esm` inlines a dynamically imported local module into the same file, and with `--splitting` writes it as a chunk beside it. Only an `--external` module stays out. It would also make `build.plan`, `synthesis.synthesize` and `validate` asynchronous in the core Provider contract.
- **A second package entry (`@vokejs/aws/runtime`) for the generated entry module.** The import that pulls deploy code in is the user's `import { aws } from "@vokejs/aws"` in `voke.config.ts`, not the generated entry, so a second entry would need users to change their config, and a second export list to keep in sync.
- **A conditional `exports` entry for `.`.** It needs a second file that repeats the whole export list, and it does not apply when the package is reached through tsconfig `paths`.
- **`--minify --keep-names`.** Under Node, stack frames show the renamed identifiers, so the frames are not readable.

## Consequences

- Plugin authors may rely on `voke-runtime`: `voke build` resolves every import of the Lambda Bundle with it, and nothing else does. A Plugin package keeps command-only code (its `cli` and their dependencies) out of the bundle with a `voke-runtime` target in its own `exports` or `imports`. Both targets must export the same names.
- A module the config imports, and a local module loaded with `await import(...)`, is in the bundle unless a condition or `build.external` keeps it out.
- Resource builders such as `dynamodbTable()` run when the config is evaluated, so the ones a project calls stay in its bundle (about 1 KB each). The rest of the synthesis module is dropped.
- A new `@vokejs/aws` capability or source file must be classified: run-time members go in `awsRuntimeCapabilities()`, deploy-time modules go on the list in the bundle test.
- Reverting is mechanical (delete the `imports` entry, import `./provider` directly, drop the flag) but becomes a breaking change once Plugin packages use the condition.
