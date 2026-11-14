import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VokeDeployError } from "voke";

import { createZip } from "../src/zip";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const entries = [
  { data: encode("export const handler = () => 'ok';\n"), path: "index.js" },
  { data: encode('{"type":"module"}\n'), path: "package.json" },
];

test("produces byte-identical archives for identical input, in any order", () => {
  const first = createZip(entries);
  const second = createZip(entries.toReversed());

  expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
});

test("writes an archive unzip can read, with readable file permissions", async () => {
  if (Bun.which("unzip") === null) {
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "voke-zip-"));
  const archive = join(directory, "bundle.zip");

  try {
    await Bun.write(archive, createZip(entries));
    const contents = Bun.spawnSync(["unzip", "-p", archive, "index.js"]);
    const listing = Bun.spawnSync(["unzip", "-Z", archive]);

    expect(contents.stdout.toString()).toBe(
      "export const handler = () => 'ok';\n"
    );
    expect(listing.stdout.toString()).toContain("-rw-r--r--");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects bundles beyond the classic zip entry limit", () => {
  const tooMany = Array.from({ length: 0x1_00_00 }, (_, index) => ({
    data: new Uint8Array(),
    path: `f${index}.js`,
  }));

  expect(() => createZip(tooMany)).toThrow(VokeDeployError);
});
