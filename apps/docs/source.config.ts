import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { transformerTwoslash } from "fumadocs-twoslash";
import { createFileSystemTypesCache } from "fumadocs-twoslash/cache-fs";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Keeps each page's processed Markdown for llms.txt and the per-page Markdown routes.
    postprocess: { includeProcessedMarkdown: true },
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      // Twoslash popups cannot lazy-load languages, so the common ones are loaded up front.
      langs: ["js", "jsx", "ts", "tsx"],
      themes: { dark: "github-dark", light: "github-light" },
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        // Blocks marked `twoslash` are compiled against the workspace packages. A type error
        // fails the build, so a sample cannot drift from the API it documents.
        transformerTwoslash({
          // Bun's types (which include Node's) let samples use process.env, Bun.env and bun:test.
          // `@vokejs/source` resolves the workspace packages to their source, as the root tsconfig
          // does, so samples compile without building declaration files first.
          twoslashOptions: {
            compilerOptions: {
              customConditions: ["@vokejs/source"],
              types: ["bun"],
            },
          },
          typesCache: createFileSystemTypesCache(),
        }),
      ],
    },
  },
});
