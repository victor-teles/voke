import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { siteDescription, siteName, siteUrl } from "@/lib/site";

import "./global.css";

export const metadata: Metadata = {
  description: siteDescription,
  metadataBase: siteUrl,
  openGraph: {
    description: siteDescription,
    siteName,
    type: "website",
  },
  title: {
    default: `${siteName} Docs`,
    template: `%s | ${siteName}`,
  },
  twitter: { card: "summary_large_image" },
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
