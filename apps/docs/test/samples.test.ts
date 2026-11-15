import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const contentDirectory = join(import.meta.dir, "..", "content", "docs");

/**
 * Pages whose TypeScript samples are not compiled yet. This list may only shrink: the test fails
 * when a listed page has no unchecked sample left, so remove it from here once converted.
 */
export const legacyUncheckedPages: readonly string[] = [];

const fencePattern = /^```(?:ts|tsx)(?:[ \t]+(?<meta>[^\n]*))?$/gmu;

const mdxFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return mdxFiles(path);
      }

      return Promise.resolve(entry.name.endsWith(".mdx") ? [path] : []);
    })
  );

  return nested.flat();
};

/** The `ts`/`tsx` fences on a page that are not compiled by Twoslash. */
export const uncheckedSamples = (source: string): string[] =>
  [...source.matchAll(fencePattern)]
    .filter(
      (match) => !(match.groups?.meta ?? "").split(/\s+/u).includes("twoslash")
    )
    .map(([fence]) => fence);

const pages = async (): Promise<Map<string, string[]>> => {
  const files = await mdxFiles(contentDirectory);
  const entries = await Promise.all(
    files.map(
      async (file) =>
        [
          relative(contentDirectory, file),
          uncheckedSamples(await readFile(file, "utf-8")),
        ] as const
    )
  );

  return new Map(entries);
};

test("recognizes checked and unchecked TypeScript fences", () => {
  const source = [
    "```ts twoslash",
    "```",
    '```tsx title="page.tsx" twoslash',
    "```",
    "```ts",
    "```",
    "```bash",
    "```",
  ].join("\n");

  expect(uncheckedSamples(source)).toEqual(["```ts"]);
});

test("every TypeScript sample is compiled by Twoslash", async () => {
  const unchecked = [...(await pages())]
    .filter(
      ([page, fences]) =>
        fences.length > 0 && !legacyUncheckedPages.includes(page)
    )
    .map(([page, fences]) => `${page}: ${fences.length} unchecked`);

  // Mark the fence `ts twoslash` (or `tsx twoslash`) and make the sample compile.
  expect(unchecked).toEqual([]);
});

test("the legacy list only names pages that still have unchecked samples", async () => {
  const all = await pages();
  const converted = legacyUncheckedPages.filter(
    (page) => (all.get(page) ?? []).length === 0
  );

  // Remove these pages from legacyUncheckedPages.
  expect(converted).toEqual([]);
});
