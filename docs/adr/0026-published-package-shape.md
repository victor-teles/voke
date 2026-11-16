# Packages ship TypeScript source to run and declaration files to type-check, at one shared version

Voke's nine packages (`voke` and eight `@voke/*` packages) used to point `exports` and `types` at their TypeScript source. Bun runs that source directly, but a project's compiler then type-checked Voke's files with the project's own flags, and `skipLibCheck` does not help because it only covers `.d.ts` files. A project with `exactOptionalPropertyTypes` got 44 errors inside Voke, one with `noPropertyAccessFromIndexSignature` got 136. Every package was at `0.0.0`, several packages could install a second copy of core, and the Project Starter depended on `latest` and on a floating TypeScript nightly.

## Decision

**Each entry point has three conditions.** Every `exports` entry, and `@voke/aws`'s `#provider` import (ADR 0022, which keeps `voke-runtime` first), is an object in this order: `"@voke/source"` and `"default"` point at the TypeScript file under `./src/`, and `"types"` at the declaration file under `./dist/`. The top-level `types` matches `exports["."].types`, and `files` is `["src", "dist", "README.md", "LICENSE"]`. A project's compiler reads only the `.d.ts` files, so its flags stop applying to Voke's code. Bun and `voke build` load `src`, which is what the test suite runs, and `bin` stays `./src/cli.ts`. Inside the repository, the root tsconfig and the docs' Twoslash options set `customConditions: ["@voke/source"]`, so packages, examples and docs samples resolve each other's source with no build step. Each package emits its declarations with `bunx tsgo --project tsconfig.build.json` before packing. Projects must use `moduleResolution: "bundler"`.

**One version for all packages, set by a script.** `bun scripts/release.ts version <x.y.z>` writes the version into the nine manifests after `CHANGELOG.md` has a section for it. Internal ranges stay `workspace:*`; `bun pm pack` rewrites them to the exact version, so `@voke/aws@0.1.0` requires `voke@0.1.0`. The changelog is written by hand. The first version is `0.1.0`: `0.x` says the API can still change (ADR 0007 removes names without aliases), and a caret on `0.1.0` accepts patch releases only.

**One copy of each shared dependency.** A package the project also imports directly is a peer dependency, and a dev dependency of the same range in the repository: `hono` for `voke` and `@voke/aws` (the Gateway's escape hatch is Hono middleware, so the project and Voke must share it), `voke` for every `@voke/*` package that imports it, and `@voke/aws` for `@voke/idempotency`. Helper packages a project does not import directly (`@voke/build` and `@voke/http` inside `@voke/aws`) stay dependencies. A second installed copy of core would break `instanceof InvokeError` and core's module-level registries; with peers, a mismatch is a peer warning instead. No manifest uses `latest`; shared tool versions live in the root `catalog`.

## Considered options

- **Compiled JavaScript in `dist`.** Bun runs TypeScript, and a Node-only toolchain is outside the supported path (ADR 0007), so compiled output buys nothing. One `bun build` per entry point would also give core's `index` and `cli` separate copies of shared modules and their state, and `bin` would run code no test covers. To move to it later, repoint `default`; the `exports` keys stay.
- **Changesets.** It adds a file per change, and its publish step runs `npm publish`, which does not rewrite `workspace:*`. Reverse: add `@changesets/cli` with a `fixed` group over the nine packages and delete the `version` command.
- **`voke` and `hono` as plain dependencies.** That is what the packages had; a project that updates one package and not the others can silently install a second copy of core.

## Consequences

- An exported value whose inferred type names an unexported type fails `bun run build` with `TS2883`: export the type or annotate the value.
- A new package needs an entry in `publishedPackages` (`scripts/release.ts`), a `tsconfig.build.json`, the manifest shape above and an import in the smoke test; `scripts/release.test.ts` enforces the manifest shape.
- A project that updates one Voke package sees peer warnings until it updates all of them.
- `bun run smoke:pack`, run by CI on every pull request, installs the packed packages into a fresh project and type-checks it with a stricter tsconfig; publishing stays the owner's action (`docs/releasing.md`).
