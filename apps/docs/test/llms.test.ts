import { expect, test } from "bun:test";

import { docsLlms, markdownUrl, pageMarkdown, source } from "@/lib/source";

test("llms.txt lists every docs page with a link", () => {
  const index = docsLlms.index();

  for (const page of source.getPages()) {
    expect(index).toContain(`[${page.data.title}](${page.url})`);
  }
});

test("a page renders as Markdown with its title, description and code", async () => {
  const page = source.getPage(["getting-started"]);

  if (page === undefined) {
    throw new Error("getting-started page is missing");
  }

  const markdown = await pageMarkdown(page);

  expect(markdown).toStartWith("# Getting Started (/docs/getting-started)");
  expect(markdown).toContain(page.data.description ?? "");
  expect(markdown).toContain("voke create my-api");
  expect(markdownUrl(page)).toBe("/llms.mdx/docs/getting-started");
});
