# Plan 012: The docs site checks its own code samples, is readable by AI assistants, and has a real landing page

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; report status to it instead of editing the index.
>
> **Drift check**: Compare `git diff --stat 95a9ec6 -- apps/docs .github/workflows .gitignore turbo.json`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. Stacks on plan 011 if it has landed, else on plan 007 (branch `feature/aws-emulator-local-provider`, PR #59). Plan 013 (docs content) depends on this plan.
- **Category**: docs
- **Planned at**: commit `95a9ec6`, 2026-11-14

## Why this matters

An audit on 2026-11-14 found the landing page's code sample invalid: it shows
`cloudFormation: { resources }` and imports `dynamodbTable` from `@voke/aws`, both of which Voke
now rejects. Nothing caught it, because the sample is about 80 hand-coloured `<span>` elements and
no code sample on the site is compiled. The site also has no favicon, no social preview, no
navigation on the landing page, unpinned `"latest"` dependencies, and is never built in CI. This
plan gives the site the machinery of a modern docs site: samples that fail the build when they stop
compiling, type hovers, `llms.txt`, link checking, and a landing page built from real code. Plan
013 then rewrites the content on top of it.

## Current state

Verified at `95a9ec6` by reading the source and running the site locally.

- The site is `apps/docs` (package `@voke/docs`): Fumadocs on Next.js. Installed versions (from
  `bun.lock`): `fumadocs-core` 16.8.12, `fumadocs-ui` 16.8.12, `fumadocs-mdx` 15.0.7, `next` 16.2.6,
  `react` 19.2.6, `tailwindcss` 4.3.0. Every dependency in `apps/docs/package.json` is `"latest"`.
- Files:
  - `apps/docs/app/layout.tsx`: root layout with `RootProvider`; metadata has only `title` and `description`.
  - `apps/docs/app/page.tsx` (142 lines): the landing page. No layout or navigation. The hero sample
    is hand-built from `<span className="voke-code-*">` elements (`page.tsx:56-121`) and is invalid.
    Its heading is "Voke functions".
  - `apps/docs/app/docs/layout.tsx`: `DocsLayout` with `baseOptions()`.
  - `apps/docs/app/docs/[[...slug]]/page.tsx`: `DocsPage`, `DocsTitle`, `DocsDescription`, `DocsBody`.
  - `apps/docs/components/mdx.tsx`: spreads `fumadocs-ui/mdx` defaults only.
  - `apps/docs/lib/layout.shared.tsx`: nav title "Voke" and one GitHub link (`https://github.com/victor-teles/voke`).
  - `apps/docs/lib/source.ts`: `loader({ baseUrl: "/docs", source: docs.toFumadocsSource() })`.
  - `apps/docs/source.config.ts`: `defineDocs({ dir: "content/docs" })` and `defineConfig()` with no options.
  - `apps/docs/next.config.mjs`: `reactStrictMode: true`, wrapped with `createMDX()`.
  - `apps/docs/app/api/search/route.ts`: Orama search through `createFromSource`.
  - `apps/docs/app/global.css`: Tailwind 4, `fumadocs-ui/css/neutral.css` and `preset.css`, custom
    light and dark tokens (`--color-fd-primary: #0f5f59` light, `#74d3c5` dark), and the
    `voke-hero`, `voke-card` and `voke-code-*` classes.
  - `apps/docs/content/docs/`: 9 pages and `meta.json`.
  - There is no `apps/docs/public/`, no icon, no Open Graph image, no `robots`, no `sitemap`.
- Scripts in `apps/docs/package.json`: `dev` (`next dev --port 3942`), `generate` (`fumadocs-mdx`),
  `build` (`next build --webpack`), `typecheck`, `clean`. There is no `test` script.
- `apps/docs/tsconfig.json` includes `**/*.ts` and `**/*.tsx`, with paths `@/*` and `collections/*`.
  `apps/docs` has no dependency on `voke` or any `@voke/*` package.
- `turbo.json`: `test` depends on `build`, and `typecheck` depends on `^build`. CI
  (`.github/workflows/ci.yml`) runs `bun run check`, `bun run typecheck` and `bun run test`. Because
  `@voke/docs` has no `test` script, CI never runs `next build` for the site.
- `.gitignore` already lists `.next` and `.source`.
- `packages/core/test/public-surface.test.ts` reads `apps/docs/app/layout.tsx` and
  `apps/docs/app/page.tsx` as "teaching surfaces" and fails if they contain removed names such as
  `createGateway`, `defineFunction`, `jsonError`, "Bun-first" or "Hono-compatible APIs".
- Verified exports in the installed packages: `fumadocs-core/highlight`, `fumadocs-core/source`
  (exports `llms`), `fumadocs-ui/layouts/home`, `fumadocs-ui/components/{steps,tabs,files,type-table,codeblock,callout,card}`,
  `fumadocs-ui/og`, and `fumadocs-ui/layouts/docs/page`.
- Local run on 2026-11-14: the landing page and docs pages fit a 390 px viewport with no horizontal
  scroll. The dark theme is the default look; the light tokens exist.
- There is no brand kit, `DESIGN.md` or `PRODUCT.md`. The theme tokens in `global.css` are the only
  design source.
- Hosting is not decided (owner decision on 2026-11-14). There is no deploy configuration.

## Decisions taken in this plan

- **Samples are checked by Twoslash.** A `ts`/`tsx` code block marked `twoslash` is compiled during
  `next build`; a type error fails the build, and readers get type hovers. This is one mechanism for
  both owner-selected features ("checked code samples" and "type hovers").
- **A policy test keeps samples checked.** A test fails when a page has a `ts`/`tsx` block without
  `twoslash`, except pages in a short legacy allowlist that plan 013 empties.
- **The landing page shows real files.** Its samples are `.ts` files under `apps/docs/snippets/`,
  typechecked with the app and highlighted at build time. No hand-coloured markup.
- **CI builds the site through the existing `test` task.** `@voke/docs` gets a `test` script, so
  `turbo run test` runs `next build` first (`test` depends on `build`). No workflow change is needed.
- **The public URL is one variable.** `NEXT_PUBLIC_SITE_URL` (default `http://localhost:3942`)
  feeds `metadataBase`, the sitemap, `robots` and `llms.txt`. No deploy is added.
- **Search stays on the server route** (`app/api/search/route.ts`). A static export is a hosting
  decision and is out of scope.
- **Icon:** a simple "V" monogram SVG in the theme's primary color. It is a placeholder until a
  brand exists; say so in the report.

## Commands you will need

| Purpose        | Command                             | Expected on success            |
| -------------- | ----------------------------------- | ------------------------------ |
| Install        | `bun install`                       | exit 0                         |
| Dev server     | `cd apps/docs && bun run dev`       | serves `http://localhost:3942` |
| Site build     | `cd apps/docs && bun run build`     | exit 0                         |
| Site tests     | `cd apps/docs && bun test`          | 0 fail                         |
| Site typecheck | `cd apps/docs && bun run typecheck` | exit 0                         |
| Repo gates     | `bun run typecheck && bun run test` | exit 0                         |
| Lint/format    | `bun run check`                     | exit 0                         |
| Format fix     | `bun x ultracite fix`               | exit 0                         |

`next dev` and `next build` rewrite `apps/docs/next-env.d.ts`. Restore it with
`git checkout -- apps/docs/next-env.d.ts` before finishing; do not commit that change.

## Implementation rules relevant to this plan

- Use Bun (`bun install`, `bun run`, `bun test`), not npm, pnpm or vite.
- Fumadocs API details must match the installed versions. The setup pages are:
  - Twoslash: `https://www.fumadocs.dev/docs/markdown/twoslash`
  - LLM output: `https://www.fumadocs.dev/docs/integrations/llms`
  - Link validation: `https://www.fumadocs.dev/docs/markdown/validate-links`
  - Page layout (Edit on GitHub, view options): `https://www.fumadocs.dev/docs/ui/layouts/page`
    If a page disagrees with the installed version, the installed version's types win.
- Twoslash setup, as documented for these versions:

  ```ts
  // apps/docs/source.config.ts
  import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
  import { defineConfig, defineDocs } from "fumadocs-mdx/config";
  import { transformerTwoslash } from "fumadocs-twoslash";

  export const docs = defineDocs({
    dir: "content/docs",
    docs: { postprocess: { includeProcessedMarkdown: true } }, // needed for llms output
  });

  export default defineConfig({
    mdxOptions: {
      rehypeCodeOptions: {
        langs: ["js", "jsx", "ts", "tsx"], // required for Twoslash popups
        themes: { dark: "github-dark", light: "github-light" },
        transformers: [
          ...(rehypeCodeDefaultOptions.transformers ?? []),
          transformerTwoslash(),
        ],
      },
    },
  });
  ```

  Also: `serverExternalPackages: ["typescript"]` in `next.config.mjs`;
  `@import "fumadocs-twoslash/twoslash.css";` in `global.css`;
  `...Twoslash` from `fumadocs-twoslash/ui` spread into `getMDXComponents`; and `.twoslash` added
  to `.gitignore` (Twoslash writes blocks there while analyzing).

- Twoslash resolves types from `apps/docs`. Add the packages samples import as
  `devDependencies` of `apps/docs`: `voke`, `@voke/aws`, `@voke/schema`, `@voke/testing`,
  `@voke/http`, `@voke/remote` (all `workspace:*`), and `hono` at the version core uses.
- Multi-file samples use Twoslash's `// @filename: voke.config.ts` and hide setup with
  `// ---cut---`. A sample that must show an error uses `// @errors: <code>`. Never use
  `// @noErrors` to silence a real mistake.
- LLM output, as documented for these versions: `export const docsLlms = llms(source, { renderPage })`
  in `lib/source.ts` with `await page.data.getText("processed")`; route handlers
  `app/llms.txt/route.ts` (`docsLlms.index()`), `app/llms-full.txt/route.ts` (`docsLlms.full()`) and
  `app/llms.mdx/docs/[[...slug]]/route.ts` (`docsLlms.page(page)`, content type `text/markdown`),
  each with `export const revalidate = false`.
- Accessibility: one `h1` per page, real `<nav>` and `<main>` landmarks, visible focus styles,
  WCAG AA contrast in both themes, and every interactive element reachable by keyboard.
- Layout: no horizontal scroll at 390 px; a 16 px side gutter on small screens.
- Keep the existing theme tokens in `global.css`. Do not add a UI library or new fonts.
- Code style: Ultracite (Oxlint + Oxfmt). Function components only. No `dangerouslySetInnerHTML`
  unless the highlighter requires it; prefer the React output of `fumadocs-core/highlight`.
- The landing page and layout must keep passing `packages/core/test/public-surface.test.ts`
  (no removed API names, no "Bun-first", no "Hono-compatible APIs").
- Vocabulary (from `CONTEXT.md`): **Function**, **Function Registry**, **Gateway**, **Route
  Builder**, **Provider** (`aws()`), **Local AWS Provider**. Use these exact terms.

## Scope

**In scope**:

- `apps/docs/package.json`, `bun.lock`: pinned versions, new dependencies (`fumadocs-twoslash`,
  `next-validate-link`, the workspace packages above), `test` and `lint:links` scripts
- `apps/docs/source.config.ts`, `apps/docs/next.config.mjs`, `apps/docs/app/global.css`,
  `apps/docs/components/mdx.tsx`, `apps/docs/lib/source.ts`, `apps/docs/lib/layout.shared.tsx`,
  `apps/docs/lib/site.ts` (create: site URL and GitHub constants)
- `apps/docs/app/layout.tsx`, `apps/docs/app/page.tsx`, `apps/docs/app/(home)/` if a route group is
  cleaner, `apps/docs/app/docs/[[...slug]]/page.tsx`, `apps/docs/app/not-found.tsx` (create)
- `apps/docs/app/icon.svg`, `apps/docs/app/robots.ts`, `apps/docs/app/sitemap.ts`, an Open Graph
  image route (create)
- `apps/docs/app/llms.txt/route.ts`, `apps/docs/app/llms-full.txt/route.ts`,
  `apps/docs/app/llms.mdx/docs/[[...slug]]/route.ts` (create)
- `apps/docs/snippets/*.ts` (create), `apps/docs/scripts/lint-links.ts` (create),
  `apps/docs/test/*.test.ts` (create)
- `apps/docs/content/docs/getting-started.mdx` and `apps/docs/content/docs/index.mdx`: only to mark
  their existing `ts` blocks `twoslash` and make them compile (the proof pages)
- `.gitignore` (`.twoslash`), `packages/core/test/public-surface.test.ts` (file lists only, if a
  file it reads moves)

**Out of scope**:

- Rewriting or restructuring documentation content (plan 013). The other seven pages keep their text.
- Hosting, deploy workflows, analytics, versioned docs, internationalization.
- A static export or a hosted search service.
- A logo or brand system beyond the placeholder icon.
- Generated API reference from TypeScript types (candidate follow-up).
- `.github/workflows/ci.yml`, unless Step 6 shows the site build is not triggered.

## Git workflow

- Branch: `feature/docs-site-platform`, created from the tip of the plan stack
  (`feature/real-standard-schema` if plan 011 landed, else `feature/aws-emulator-local-provider`).
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin versions and add the tooling

Replace every `"latest"` in `apps/docs/package.json` with a caret range of the version in
`bun.lock`. Add `fumadocs-twoslash`, `next-validate-link` and the workspace packages. Add scripts
`"test": "bun test"` and `"lint:links": "bun scripts/lint-links.ts"`.

### Step 2: Checked samples with type hovers

Apply the Twoslash setup from "Implementation rules". Mark the `ts` blocks in
`getting-started.mdx` and `index.mdx` as `twoslash` and make them compile against the real packages.

**Evidence**: temporarily break one sample (for example pass a number as `name`) and run
`cd apps/docs && bun run build`: the build must fail and name the file. Restore it; the build
passes. If the build passes with the broken sample, set the transformer to throw on errors and
repeat. Record the result in the report.

### Step 3: Sample policy test

Create `apps/docs/test/samples.test.ts`: for every `.mdx` file under `content/docs`, every fenced
block whose language is `ts` or `tsx` must carry `twoslash`. Pages not yet converted are listed in
one exported `legacyUncheckedPages` array (the pages this plan does not touch that have `ts` blocks). The test also
fails when a listed page no longer has unchecked blocks, so the list can only shrink. Plan 013 must
end with the list empty.

### Step 4: Landing page from real code

- Create `apps/docs/snippets/voke.config.ts` and `apps/docs/snippets/index.ts`: a minimal, valid
  project (config with `provider: aws()` and one resource; an entrypoint with one typed route).
  They are compiled by `bun run typecheck` because `tsconfig.json` includes `**/*.ts`.
- Rebuild `app/page.tsx` inside Fumadocs' `HomeLayout` (`fumadocs-ui/layouts/home`) with
  `baseOptions()`, so the landing page has the same navigation as the docs (Docs, GitHub, search,
  theme switch).
- Content, top to bottom: a one-line statement of what Voke is; the three commands
  (`voke create my-api`, `cd my-api`, `bun run deploy`) in a copyable block; primary action
  "Get started" → `/docs/getting-started` and secondary "GitHub"; the two snippet files shown as
  tabs, read from disk at build time and highlighted with `fumadocs-core/highlight`; three short
  feature cards that link to real pages.
- Delete the `<span>`-built sample and the `voke-code-*` classes.
- Add `app/not-found.tsx` using `fumadocs-ui/layouts/home/not-found` or a small equivalent.

### Step 5: Metadata, discovery and page actions

- `lib/site.ts`: `siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3942"`, plus the
  GitHub owner, repository, branch (`main`) and content path (`apps/docs/content/docs`).
- `app/layout.tsx`: `metadataBase`, Open Graph and Twitter metadata. Add `app/icon.svg`,
  `app/robots.ts`, `app/sitemap.ts` (from `source.getPages()`), and an Open Graph image per docs
  page with `fumadocs-ui/og`, wired through `generateMetadata` in the docs page.
- Docs page: an "Edit on GitHub" link built from `lib/site.ts` and `page.path`, and the view
  options that copy the page as Markdown (the documented `ViewOptionsPopover`).
- Add the three LLM routes and `docsLlms` from "Implementation rules".
- Register `Steps`, `Step`, `Tabs`, `Tab`, `Files`, `File`, `Folder` and `TypeTable` in
  `components/mdx.tsx`, so plan 013 can use them without imports in every page.

### Step 6: Link checking and CI

- `apps/docs/scripts/lint-links.ts`: the documented `next-validate-link` script, checking every
  internal link and heading anchor in `content/docs`. Run it from a test in `apps/docs/test/` (or
  call the same function), so `bun test` fails on a broken link.
- Run `bun run test` at the repository root and confirm in the output that turbo runs
  `@voke/docs:build` before `@voke/docs:test`. If it does not, add an explicit "Build docs" step to
  `.github/workflows/ci.yml` and say so in the report.

## Test plan

- `apps/docs/test/samples.test.ts`: the policy from Step 3, including the "list can only shrink" case.
- `apps/docs/test/links.test.ts`: no broken internal links or anchors.
- `apps/docs/test/llms.test.ts`: the `llms.txt` index lists every page in `content/docs/meta.json`,
  and one rendered page contains its title and a code sample as Markdown.
- Manual checks with the dev server, recorded in the report with screenshots: landing page and one
  docs page at 1440 px and 390 px, in light and dark; keyboard-only navigation of the landing page;
  a type hover on a `twoslash` sample.
- Structural pattern for tests: `packages/core/test/public-surface.test.ts` (file-reading tests with `bun:test`).

## Done criteria

- [ ] `grep -c '"latest"' apps/docs/package.json` → 0
- [ ] `cd apps/docs && bun run build` exits 0, and fails when a `twoslash` sample has a type error (evidence from Step 2)
- [ ] `cd apps/docs && bun test` → 0 fail (samples policy, links, llms)
- [ ] `grep -c 'voke-code-' apps/docs/app/page.tsx apps/docs/app/global.css` → 0 for both
- [ ] With the dev server running: `/llms.txt`, `/llms-full.txt` and `/docs/getting-started.md` (or the documented Markdown URL) return text; `/sitemap.xml` and `/robots.txt` exist; the page `<head>` has an icon and an `og:image`
- [ ] The landing page has a navigation bar and shows the two snippet files; both compile under `bun run typecheck`
- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0 at the root, and the root `bun run test` builds the docs site
- [ ] `git status --short` shows no change to `apps/docs/next-env.d.ts` and no files outside the in-scope list

## STOP conditions

- `fumadocs-twoslash` does not work with the installed Fumadocs or Next.js versions, or cannot
  resolve workspace packages from `apps/docs`. Report the error. Do not replace it with a different
  checking mechanism without the owner's agreement, because type hovers were explicitly requested.
- The site build takes more than about 5 minutes in CI because of Twoslash. Report the timing and
  the cache options before changing the approach.
- A sample on the two proof pages cannot be made to compile because the documented API does not
  exist or is typed differently. Report it: that is a product or documentation bug for plan 013.
- Making the root `bun run test` build the site breaks another package's test task or the turbo
  cache. Report it and use an explicit CI step instead.
- A hosting decision is needed to finish a step (it should not be: the URL is one variable).

## Maintenance notes

- New docs pages get checked samples by default: the policy test fails for an unmarked `ts` block.
- Set `NEXT_PUBLIC_SITE_URL` when a host is chosen; nothing else changes.
- The icon is a placeholder. Replace `app/icon.svg` when a brand exists.
- Reviewers should check both themes, the 390 px layout, keyboard focus, and that the landing
  samples come from `apps/docs/snippets/`.
- Deferred: hosting and deploy, an API reference generated from types, a static search index,
  versioned docs, and "last updated" dates.

## Execution notes (2026-11-14)

Done on branch `feature/docs-site-platform` (PR #61), stacked on plan 011 (`feature/real-standard-schema`,
PR #60). Gates: `bun run check` 0 errors, `bun run typecheck` 19/19, `bun run test`
24/24 tasks (docs 7, core 247, `@voke/aws` 99). The root test run builds the docs site before
testing it (`@voke/docs:build` precedes `@voke/docs:test` in the turbo log), so CI builds it with no
workflow change.

- **Versions:** every `"latest"` in `apps/docs/package.json` is pinned to the installed version
  (Fumadocs 16.8.12, MDX 15.0.7, Next 16.2.6, React 19.2.6, Tailwind 4.3.0, TypeScript 6.0.3).
  - `fumadocs-twoslash` is **3.3.1**. 4.x needs `fumadocs-core` 16.15+, which would have meant
    upgrading every Fumadocs package; 3.x works with the installed 16.8.
  - The workspace packages and `hono` are `devDependencies`, so samples resolve.
- **Checked samples:** blocks marked `ts twoslash` compile against the real packages during
  `next build`, with type hovers and a file-system type cache.
  - Evidence: setting `name: 42` in a Getting Started sample made `bun run build` exit 1, naming
    `content/docs/getting-started.mdx` and error 2322. The sample was restored and the build passes.
  - `getting-started.mdx` (3 samples) and `index.mdx` (1) are converted, using hidden `voke.config.ts`
    setup through `// @filename` and `// ---cut---`.
- **Sample policy:** `test/samples.test.ts` fails on any unchecked `ts`/`tsx` block outside
  `legacyUncheckedPages`. That list has 5 pages (deploy, functions, gateway-testing, local-aws,
  config); the test also fails if a listed page has no unchecked block left.
- **Landing page** (`app/(home)/`):
  - It uses `HomeLayout` with the docs navigation: Docs, search, theme, GitHub.
  - Content: one `h1`, the three commands in a copyable block, "Get started" and "Read the docs",
    tabs showing `snippets/voke.config.ts` and `snippets/index.ts`, and three feature cards linked to
    real pages.
  - The snippets are compiled by the app's typecheck and highlighted at build time. The
    `<span>`-built sample and the `voke-code-*` classes are gone.
  - Added `app/not-found.tsx`.
- **Metadata and discovery:** `lib/site.ts` (`NEXT_PUBLIC_SITE_URL`, default `http://localhost:3942`)
  feeds `metadataBase`, Open Graph/Twitter, `robots.txt` and `sitemap.xml`. Added a placeholder "V"
  icon (`app/icon.svg`) and a per-page Open Graph image at `/og/<slug>/image.png`.
- **Page actions:** "Copy Markdown" and the "Open" menu (with the GitHub edit link) appear under each
  title.
- **LLM routes:** `/llms.txt`, `/llms-full.txt` and `/llms.mdx/docs/<slug>`. This Fumadocs version's
  `llms()` has only `index`, so pages render from `page.data.getText("processed")`.
- **Components:** `Steps`, `Tabs`, `Files`, `Callout`, `Cards` and `TypeTable` are registered in
  `components/mdx.tsx`.
- **Link checking:** `scripts/lint-links.ts` (`bun run lint:links`) runs `next-validate-link`, and
  `test/links.test.ts` fails on a broken link or anchor. It was proven by adding a missing page and a
  missing anchor, which were both reported. Bun loads the content through `scripts/mdx-preload.ts`
  (the Fumadocs MDX plugin; its setup is async and must be awaited).
- **Tests:** `test/llms.test.ts` (every page in `llms.txt`; page Markdown) and
  `test/edit-links.test.ts` (every edit URL resolves to a real file).

Checked in the browser against `next start`:

- Every route returns the right status and content type, and an unknown page returns 404.
- The landing page at 1440 px (light and dark) and 390 px (dark) has no horizontal scroll, one `h1`,
  and `nav`/`main` landmarks. Tabbing goes Voke → Docs → Search → Theme → GitHub → Copy → code → Get
  started → Read the docs → tabs, each with a visible focus style.
- A Twoslash popup opens and shows `createFunctions`' real signature.

Bugs found and fixed while checking:

- Highlighted code on the landing page rendered light in dark mode. Fixed with `defaultColor: false`,
  as Fumadocs' own code blocks use.
- The theme's `secondary` token was a strong accent (orange in dark, near-black in light), but
  Fumadocs draws subtle surfaces with it: the search box, tab lists and buttons. That made tab
  labels illegible. It is now a subtle surface color in both themes.
- Twoslash popups opened behind the sticky docs sidebar (z-index 20), because their positioner forms
  a stacking context. Fixed in `global.css`.

Deviations:

- `packages/aws/src/local.ts`: `captureCommand` typed its child environment as a plain `Record`, so
  `@voke/aws` source failed to typecheck in a Next.js app, where `NODE_ENV` is a required field of
  `process.env`. It is now typed as `NodeJS.ProcessEnv`. This was outside the listed scope.
- The landing page moved to `app/(home)/page.tsx`, and `public-surface.test.ts` reads it there.
- No `.twoslash` entry in `.gitignore`: fumadocs-twoslash 3.x does not write that folder.
- The "Open" menu's links could not be read through the browser tool. The edit URLs are covered by
  `test/edit-links.test.ts` instead.
