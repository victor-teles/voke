import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions = (): BaseLayoutProps => ({
  links: [
    {
      external: true,
      text: "GitHub",
      url: "https://github.com/victor-teles/voke",
    },
  ],
  nav: {
    title: "Voke",
  },
});
