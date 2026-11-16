# Releasing

This is the one release procedure. All nine packages (`voke` and the eight `@vokejs/*` packages)
share one version and are released together. The procedure ends at a set of verified tarballs;
publishing them is the owner's action, and no registry token is stored anywhere in the
repository or in CI.

## 1. Gates only the owner can clear

The procedure names these gates and does not perform them. Do not start step 6 while one is
open.

1. **The names are available.** The npm package name `voke` and the scope `@vokejs` are free and
   owned by the publishing account. Nobody has checked this. If either is taken, stop and plan a
   rename; do not publish under other names.
2. **A real AWS deploy has run.** The real-AWS smoke deploy of plan 004 (step 8) and the durable
   Function deploy of plan 018 (step 8) have run with the owner's credentials.
3. **The S3 key encoding is confirmed.** The S3 object key encoding of plan 017 (ADR 0013) is
   confirmed against a real bucket.
4. **The release commit is on `main`.** The package READMEs link to `blob/main/apps/docs/...`,
   so those links work only once the release commit is on `main`. (`origin/main` stopped at PR
   #52 when this was written; the newer work is on stacked branches.)

## 2. Write the changelog

Add a `## <version>` section at the top of `CHANGELOG.md`. Use `x.y.z`, or `x.y.z-rc.n` for a
pre-release. While Voke is `0.x`, a release with breaking changes raises the minor version
(`0.1.x` → `0.2.0`): the Project Starter's `^0.1.0` ranges accept patch releases only.

## 3. Set the version

```bash
bun scripts/release.ts version <version>
```

It refuses a version without a `CHANGELOG.md` section. It writes the version into the nine
`packages/*/package.json` files and the version lines of `reference/cli.mdx` and
`reference/packages.mdx`, then runs `bun install` so `bun.lock` records the new workspace
versions (CI installs with `--frozen-lockfile`). Commit the result.

## 4. Run the release checks

```bash
bun run release:check
```

It runs `bun run check`, `bun run typecheck`, `bun run test`, `bun test ./scripts` and
`bun run smoke:pack`. The smoke test packs the nine packages, installs them from the tarballs
into a project made by the packed CLI, type-checks it with the Project Starter's tsconfig and a
stricter one, runs its test and builds its Lambda bundle. CI runs the same smoke test on every
pull request.

## 5. Pack: the dry run

```bash
bun scripts/release.ts pack
```

It checks every manifest, packs each package with `bun pm pack` (which builds the declaration
files and rewrites `workspace:*` to the exact version), and checks each tarball: no
`workspace:` or `catalog:` range, internal ranges equal to the version, `LICENSE`, `README.md`,
`src/index.ts` and every `types` target present, no tests, and only `.d.ts` files under `dist`.
It ends with the verified tarballs in `.release/<version>/` and the publish commands, in order.
It does not publish.

`bun publish --dry-run` is not part of this procedure: it was not tried, because it may contact
the registry for the package names, and that check belongs to the owner (gate 1).

## 6. Publish (owner only)

Run the printed commands in the printed order, one per tarball:

```bash
bun publish .release/<version>/voke-<version>.tgz --access public
# … then each @vokejs/* tarball, in the printed order
```

Publish a pre-release with `--tag next`, so `bunx voke` keeps resolving the stable release.
Then tag the release commit `v<version>` and push the tag.

**A partial publish** (a command failed halfway): fix the cause and run the remaining commands.
A published version cannot be replaced, so a bad release is fixed by the next patch version.

## 7. After the first publish

Remove the "not published yet" callouts: `README.md` (the note under the title and the
"Once Voke is published" line), `apps/docs/content/docs/getting-started.mdx` (the callout at the
top and the "Try it from the repository" introduction) and
`apps/docs/content/docs/reference/packages.mdx` (the callout at the top).
