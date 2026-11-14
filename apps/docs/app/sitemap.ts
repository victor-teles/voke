import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: new URL("/", siteUrl).href },
    ...source
      .getPages()
      .map((page) => ({ url: new URL(page.url, siteUrl).href })),
  ];
}
