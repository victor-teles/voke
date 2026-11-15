// Lets Bun import the Fumadocs content collections (MDX and meta files) outside Next.js, for the
// link check and the tests.
import { plugin } from "bun";
import { createMdxPlugin } from "fumadocs-mdx/bun";

// The plugin setup is async; await it so content imports are compiled, not read as text.
await plugin(createMdxPlugin());
