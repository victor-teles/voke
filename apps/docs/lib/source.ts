import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { llms } from "fumadocs-core/source/llms";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

type DocsPage = NonNullable<ReturnType<typeof source.getPage>>;

/** The `llms.txt` index, built from the sidebar tree. */
export const docsLlms = llms(source);

/** Where a page's Markdown is served, for AI assistants and the copy button. */
export const markdownUrl = (page: DocsPage): string => `/llms.mdx${page.url}`;

/** One page as Markdown: its title, URL, description and processed content. */
export const pageMarkdown = async (page: DocsPage): Promise<string> =>
  [
    `# ${page.data.title} (${page.url})`,
    page.data.description ?? "",
    await page.data.getText("processed"),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

/** The path of a page's Open Graph image, under /og. */
export const ogImagePath = (page: DocsPage): string =>
  ["/og", ...page.slugs, "image.png"].join("/");
