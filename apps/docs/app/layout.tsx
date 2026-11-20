import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { siteDescription, siteName, siteUrl } from "@/lib/site";

// Self-hosted variable fonts: display, text and mono. No request leaves the site for them.
import "@fontsource-variable/bricolage-grotesque/wdth.css";
import "@fontsource-variable/instrument-sans";

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
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
