import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./global.css";

export const metadata: Metadata = {
  description:
    "Function-first AWS Lambda framework for Bun, Hono APIs, and typed serverless workflows.",
  title: {
    default: "Voke Docs",
    template: "%s | Voke",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
