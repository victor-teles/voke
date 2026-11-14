import { expect, test } from "bun:test";

import { findBrokenLinks } from "../scripts/lint-links";

test("every internal link and heading anchor in the docs resolves", async () => {
  const broken = await findBrokenLinks();

  expect(
    broken.flatMap((result) =>
      result.errors.map((error) => `${result.file}: ${error.url}`)
    )
  ).toEqual([]);
});
