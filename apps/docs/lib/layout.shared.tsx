import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { githubUrl, siteName } from "./site";

export const baseOptions = (): BaseLayoutProps => ({
  githubUrl,
  links: [
    {
      active: "nested-url",
      text: "Docs",
      url: "/docs",
    },
  ],
  nav: {
    title: siteName,
  },
});
