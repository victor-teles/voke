// Compiles the `ts twoslash` / `tsx twoslash` blocks of docs pages the way `next build` does, without
// a build: `bun run check:samples [page.mdx ...]` (all pages when none are given).
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import { createTwoslasher } from "twoslash";
import ts from "typescript";

const docsRoot = resolve(import.meta.dir, "..");
const contentRoot = join(docsRoot, "content", "docs");
const require = createRequire(import.meta.url);
const fencePattern =
  /^```(?<lang>ts|tsx)[ \t]+(?<meta>[^\n]*\btwoslash\b[^\n]*)\n(?<code>[\s\S]*?)^```$/gmu;

const twoslasher = createTwoslasher({
  compilerOptions: {
    baseUrl: undefined,
    // Same as source.config.ts and the root tsconfig: resolve the workspace packages to their
    // source, so samples compile without building declaration files first.
    customConditions: ["@voke/source"],
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // Same as source.config.ts: samples may use process.env, Bun.env and bun:test.
    types: ["bun"],
  },
  tsLibDirectory: dirname(require.resolve("typescript")),
  tsModule: ts,
  vfsRoot: docsRoot,
});

const allPages = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return allPages(path);
      }

      return Promise.resolve(entry.name.endsWith(".mdx") ? [path] : []);
    })
  );

  return nested.flat();
};

const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

const args = process.argv.slice(2);
const pages =
  args.length === 0
    ? await allPages(contentRoot)
    : args.map((page) => resolve(contentRoot, page));
let failures = 0;
let checked = 0;

for (const page of pages) {
  const source = await readFile(page, "utf-8");

  for (const match of source.matchAll(fencePattern)) {
    const { code = "", lang = "ts" } = match.groups ?? {};
    const where = `${relative(contentRoot, page)}:${lineOf(source, match.index)}`;

    checked += 1;

    try {
      twoslasher(code, lang);
    } catch (error) {
      failures += 1;
      console.error(
        `FAIL ${where}\n${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
}

console.log(`${checked} samples checked, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
