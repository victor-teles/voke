import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { editUrl, github } from "@/lib/site";
import { source } from "@/lib/source";

const repositoryRoot = join(import.meta.dir, "..", "..", "..");

test("every page's Edit on GitHub link points at its source file", async () => {
  for (const page of source.getPages()) {
    const url = editUrl(page.path);
    const prefix = `https://github.com/${github.owner}/${github.repo}/blob/${github.branch}/`;

    expect(url).toStartWith(prefix);
    await access(join(repositoryRoot, url.slice(prefix.length)));
  }
});
