import { createMDX } from "fumadocs-mdx/next";

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  // Twoslash loads the TypeScript compiler on the server; it must not be bundled.
  serverExternalPackages: ["typescript", "twoslash"],
};

const withMDX = createMDX();

export default withMDX(config);
