import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiProject } from "../packages/core/src/scaffold";
import {
  changelogHasVersion,
  manifestProblems,
  packedProblems,
  publishedPackages,
  sourceCondition,
  withTarballOverrides,
  withVersion,
} from "./release";
import type { PackageManifest } from "./release";

const root = join(import.meta.dir, "..");

const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(path, "utf-8")) as PackageManifest;

const directoriesIn = async (directory: string): Promise<string[]> => {
  const entries = await readdir(join(root, directory), { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}`)
    .toSorted();
};

const workspaceManifests = async (): Promise<string[]> => {
  const directories = [
    ...(await directoriesIn("apps")),
    ...(await directoriesIn("examples")),
    ...(await directoriesIn("packages")),
  ];
  const manifests = ["package.json"];

  for (const directory of directories) {
    if (await Bun.file(join(root, directory, "package.json")).exists()) {
      manifests.push(`${directory}/package.json`);
    }
  }

  return manifests;
};

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
};

const coreManifest = await readManifest(
  join(root, "packages/core/package.json")
);
const coreVersion = coreManifest.version as string;
const rootManifest = await readManifest(join(root, "package.json"));
const rootCatalog = rootManifest.catalog as Record<string, string>;

const dependencyBlocks = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

test("the condition that resolves workspace source is @vokejs/source", () => {
  expect(sourceCondition).toBe("@vokejs/source");
});

test("publishedPackages lists every package that is not private", async () => {
  const published: { directory: string; name: string }[] = [];

  for (const directory of await directoriesIn("packages")) {
    const manifest = await readManifest(join(root, directory, "package.json"));

    if (manifest.private !== true) {
      published.push({ directory, name: manifest.name });
    }
  }

  expect(
    publishedPackages.toSorted((a, b) => a.name.localeCompare(b.name))
  ).toEqual(published.toSorted((a, b) => a.name.localeCompare(b.name)));
  expect(publishedPackages.map(({ name }) => name)).toEqual([
    "voke",
    "@vokejs/build",
    "@vokejs/http",
    "@vokejs/schema",
    "@vokejs/testing",
    "@vokejs/remote",
    "@vokejs/openapi",
    "@vokejs/aws",
    "@vokejs/idempotency",
  ]);
});

test("every published manifest has the release shape", async () => {
  for (const { directory } of publishedPackages) {
    const manifest = await readManifest(join(root, directory, "package.json"));

    expect({ [directory]: manifestProblems(manifest, coreVersion) }).toEqual({
      [directory]: [],
    });
  }
});

test("hono and voke are peers of the packages that import them", async () => {
  for (const { directory, name } of publishedPackages) {
    if (name === "voke") {
      continue;
    }

    const manifest = await readManifest(join(root, directory, "package.json"));
    let importsVoke = false;

    for (const file of await sourceFiles(join(root, directory, "src"))) {
      const source = await readFile(file, "utf-8");

      if (source.includes('from "voke"')) {
        importsVoke = true;
        break;
      }
    }

    if (importsVoke) {
      expect({ [name]: manifest.peerDependencies?.voke }).toEqual({
        [name]: "workspace:*",
      });
    }
  }

  const core = await readManifest(join(root, "packages/core/package.json"));
  const aws = await readManifest(join(root, "packages/aws/package.json"));
  const idempotency = await readManifest(
    join(root, "packages/idempotency/package.json")
  );

  expect(core.peerDependencies?.hono).toBe("^4.0.0");
  expect(aws.peerDependencies?.hono).toBe("^4.0.0");
  expect(idempotency.peerDependencies?.["@vokejs/aws"]).toBe("workspace:*");
});

test("no workspace manifest depends on the range latest", async () => {
  for (const path of await workspaceManifests()) {
    const manifest = await readManifest(join(root, path));
    const latest = dependencyBlocks.flatMap((block) =>
      Object.entries(manifest[block] ?? {})
        .filter(([, range]) => range === "latest")
        .map(([name]) => `${block}.${name}`)
    );

    expect({ [path]: latest }).toEqual({ [path]: [] });
  }
});

const packedManifest = (
  overrides: Partial<PackageManifest> = {}
): PackageManifest => ({
  dependencies: { "@vokejs/build": "1.2.3", zod: "^4.0.0" },
  devDependencies: { voke: "1.2.3" },
  exports: {
    ".": {
      [sourceCondition]: "./src/index.ts",
      default: "./src/index.ts",
      types: "./dist/index.d.ts",
    },
  },
  name: "@vokejs/example",
  peerDependencies: { voke: "1.2.3" },
  types: "./dist/index.d.ts",
  version: "1.2.3",
  ...overrides,
});

const packedFiles = [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/src/index.ts",
  "package/dist/index.d.ts",
  "package/dist/index.d.ts.map",
];

test("packedProblems accepts a correct tarball", () => {
  expect(packedProblems(packedManifest(), packedFiles, "1.2.3")).toEqual([]);
});

test("packedProblems reports unrewritten and floating ranges", () => {
  for (const range of ["workspace:*", "catalog:", "latest"]) {
    const problems = packedProblems(
      packedManifest({ dependencies: { zod: range } }),
      packedFiles,
      "1.2.3"
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("zod");
  }
});

test("packedProblems reports an internal range that is not the exact version", () => {
  const problems = packedProblems(
    packedManifest({ peerDependencies: { voke: "^1.2.3" } }),
    packedFiles,
    "1.2.3"
  );

  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("voke");
});

test("packedProblems reports missing files", () => {
  for (const missing of [
    "package/LICENSE",
    "package/README.md",
    "package/src/index.ts",
    "package/dist/index.d.ts",
  ]) {
    const problems = packedProblems(
      packedManifest(),
      packedFiles.filter((file) => file !== missing),
      "1.2.3"
    );

    expect(problems.join("\n")).toContain(missing);
  }
});

test("packedProblems reports tests and compiled JavaScript in the tarball", () => {
  expect(
    packedProblems(
      packedManifest(),
      [...packedFiles, "package/test/index.test.ts"],
      "1.2.3"
    ).join("\n")
  ).toContain("package/test/index.test.ts");
  expect(
    packedProblems(
      packedManifest(),
      [...packedFiles, "package/dist/index.js"],
      "1.2.3"
    ).join("\n")
  ).toContain("package/dist/index.js");
});

test("withVersion changes only the version line", () => {
  const text = `{\n  "name": "voke",\n  "version": "0.0.0",\n  "description": "x"\n}\n`;

  expect(withVersion(text, "0.1.0")).toBe(
    `{\n  "name": "voke",\n  "version": "0.1.0",\n  "description": "x"\n}\n`
  );
  expect(withVersion(text, "1.0.0-rc.1")).toContain('"version": "1.0.0-rc.1"');

  for (const invalid of ["1.0", "v1.0.0", ""]) {
    expect(() => withVersion(text, invalid)).toThrow();
  }
});

test("changelogHasVersion matches a version heading only", () => {
  expect(changelogHasVersion("## 0.1.0\n\n- First release.\n", "0.1.0")).toBe(
    true
  );
  expect(changelogHasVersion("## 0.1.00\n", "0.1.0")).toBe(false);
  expect(
    changelogHasVersion("## 0.2.0\n\nSince 0.1.0, things changed.\n", "0.1.0")
  ).toBe(false);
});

test("withTarballOverrides points every name at its tarball and keeps dependencies", () => {
  const manifest: PackageManifest = {
    dependencies: { "@vokejs/aws": "^1.2.3", hono: "^4.0.0", voke: "^1.2.3" },
    name: "smoke-api",
  };
  const result = withTarballOverrides(manifest, {
    "@vokejs/aws": "/tmp/voke-aws-1.2.3.tgz",
    voke: "/tmp/voke-1.2.3.tgz",
  });

  expect(result.overrides).toEqual({
    "@vokejs/aws": "file:/tmp/voke-aws-1.2.3.tgz",
    voke: "file:/tmp/voke-1.2.3.tgz",
  });
  expect(result.dependencies).toEqual(manifest.dependencies);
});

test("the docs name the current version", async () => {
  const cli = await readFile(
    join(root, "apps/docs/content/docs/reference/cli.mdx"),
    "utf-8"
  );
  const packages = await readFile(
    join(root, "apps/docs/content/docs/reference/packages.mdx"),
    "utf-8"
  );

  expect(cli).toContain(`Voke v${coreVersion}`);
  expect(cli).toContain(`voke ${coreVersion}`);
  expect(packages).toContain(`\`${coreVersion}\``);
});

test("the Project Starter pins the catalog's Bun types and TypeScript preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voke-release-starter-"));

  try {
    await createApiProject({
      directory,
      force: true,
      name: "release-starter",
    });
    const manifest = await readManifest(join(directory, "package.json"));

    expect(manifest.devDependencies?.["@types/bun"]).toBe(
      rootCatalog["@types/bun"]
    );
    expect(manifest.devDependencies?.["@typescript/native-preview"]).toBe(
      rootCatalog["@typescript/native-preview"]?.replace(/^\^/u, "")
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
