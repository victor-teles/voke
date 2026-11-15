import { printErrors, scanURLs, validateFiles } from "next-validate-link";
import type { FileObject, ValidateResult } from "next-validate-link";

import { source } from "@/lib/source";

type DocsPage = (typeof source)["$inferPage"];

const headings = (page: DocsPage): string[] =>
  page.data.toc.map((item) => item.url.slice(1));

const files = (): Promise<FileObject[]> =>
  Promise.all(
    source.getPages().map(async (page) => ({
      content: await page.data.getText("raw"),
      data: page.data,
      path: page.absolutePath ?? page.path,
      url: page.url,
    }))
  );

/** Every internal link and heading anchor in the docs content that does not resolve. */
export const findBrokenLinks = async (): Promise<ValidateResult[]> => {
  const scanned = await scanURLs({
    populate: {
      "docs/[[...slug]]": source.getPages().map((page) => ({
        hashes: headings(page),
        value: { slug: page.slugs },
      })),
    },
    preset: "next",
  });
  const results = await validateFiles(await files(), {
    checkRelativePaths: "as-url",
    markdown: { components: { Card: { attributes: ["href"] } } },
    scanned,
  });

  return results.filter((result) => result.errors.length > 0);
};

if (import.meta.main) {
  const broken = await findBrokenLinks();

  printErrors(broken, true);
}
