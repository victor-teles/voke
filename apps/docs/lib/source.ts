import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { llms } from "fumadocs-core/source/llms";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";

export const source = loader({
  baseUrl: "/docs",
  // An `icon` in a page's frontmatter or a folder's meta.json names a Lucide icon.
  plugins: [lucideIconsPlugin()],
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

/**
 * The sidebar section a page sits under ("Build", "Events", ...), read from the separators in
 * `content/docs/meta.json`. Reference pages belong to the "Reference" tab.
 */
export const pageSection = (page: DocsPage): string | undefined => {
  if (page.slugs[0] === "reference") {
    return "Reference";
  }

  let section: string | undefined;

  for (const node of source.pageTree.children) {
    if (node.type === "separator") {
      section = typeof node.name === "string" ? node.name : section;
    } else if (node.type === "page" && node.url === page.url) {
      return section;
    }
  }

  return undefined;
};
