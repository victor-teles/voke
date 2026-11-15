import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { Logo } from "@/components/logo";

import { githubUrl } from "./site";

export const baseOptions = (): BaseLayoutProps => ({
  githubUrl,
  nav: {
    title: <Logo />,
  },
});
