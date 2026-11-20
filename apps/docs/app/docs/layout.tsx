import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import type { ReactNode } from "react";

import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

const referenceUrls = new Set(
  source
    .getPages()
    .filter((page) => page.slugs[0] === "reference")
    .map((page) => page.url)
);
const documentationUrls = new Set(
  source
    .getPages()
    .filter((page) => page.slugs[0] !== "reference")
    .map((page) => page.url)
);

export default function Layout({ children }: { children: ReactNode }) {
  const options = baseOptions();

  return (
    <DocsLayout
      {...options}
      nav={{ ...options.nav, mode: "top" }}
      tabMode="navbar"
      tabs={[
        { title: "Documentation", url: "/docs", urls: documentationUrls },
        {
          title: "Reference",
          url: "/docs/reference/config",
          urls: referenceUrls,
        },
      ]}
      tree={source.pageTree}
    >
      {children}
    </DocsLayout>
  );
}
