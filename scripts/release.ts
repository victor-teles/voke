// The release tooling: `bun scripts/release.ts version <x.y.z>` sets one version on every published
// package, and `bun scripts/release.ts pack [--out <dir>]` packs and verifies the tarballs (the dry
// run). Nothing here publishes; the owner runs the printed `bun publish` commands. See
// docs/releasing.md.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

/** The `exports`/`imports` condition that makes workspace tools resolve a package to its source. */
export const sourceCondition = "@vokejs/source";

export interface PackageManifest {
  [key: string]: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  version?: string;
}

/** Publish order: a package comes after everything it needs. */
export const publishedPackages: readonly { directory: string; name: string }[] =
  [
    { directory: "packages/core", name: "voke" },
    { directory: "packages/build", name: "@vokejs/build" },
    { directory: "packages/http", name: "@vokejs/http" },
    { directory: "packages/schema", name: "@vokejs/schema" },
    { directory: "packages/testing", name: "@vokejs/testing" },
    { directory: "packages/remote", name: "@vokejs/remote" },
    { directory: "packages/openapi", name: "@vokejs/openapi" },
    { directory: "packages/aws", name: "@vokejs/aws" },
    { directory: "packages/idempotency", name: "@vokejs/idempotency" },
  ];

export const repositoryRoot = resolve(import.meta.dir, "..");

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const versionLinePattern = /^(?<prefix>\s*"version":\s*)"[^"]*"/mu;
const expectedFiles = ["src", "dist", "README.md", "LICENSE"];
const dependencyBlocks = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const sharedPeers = ["hono", "voke"] as const;

const isInternal = (name: string): boolean =>
  name === "voke" || name.startsWith("@vokejs/");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertVersion = (version: string): void => {
  if (!versionPattern.test(version)) {
    throw new Error(
      `Invalid version "${version}". Use x.y.z with an optional prerelease suffix, for example 0.1.0 or 0.2.0-rc.1.`
    );
  }
};

/** `./src/aws/index.ts` → `./dist/aws/index.d.ts`. */
const declarationPath = (sourcePath: string): string =>
  sourcePath.replace(/^\.\/src\//u, "./dist/").replace(/\.ts$/u, ".d.ts");

const entryProblems = (
  field: "exports" | "imports",
  key: string,
  entry: unknown
): string[] => {
  const where = `${field}["${key}"]`;

  if (!isRecord(entry)) {
    return [
      `${where} must be an object with the conditions "${sourceCondition}", "types", "default"`,
    ];
  }

  const conditions = Object.keys(entry);
  const order = [sourceCondition, "types", "default"].map((condition) =>
    conditions.indexOf(condition)
  );

  const inOrder = order.join(",") === order.toSorted((a, b) => a - b).join(",");

  if (order.includes(-1) || !inOrder) {
    return [
      `${where} must list the conditions "${sourceCondition}", "types", "default" in that order`,
    ];
  }

  const source = entry[sourceCondition];
  const problems: string[] = [];

  if (source !== entry.default) {
    problems.push(`${where}: "${sourceCondition}" and "default" must be equal`);
  }

  if (typeof source !== "string" || !source.startsWith("./src/")) {
    problems.push(`${where}: "${sourceCondition}" must point under ./src/`);
  } else if (entry.types !== declarationPath(source)) {
    problems.push(`${where}: "types" must be ${declarationPath(source)}`);
  }

  return problems;
};

const conditionProblems = (manifest: PackageManifest): string[] => {
  const problems: string[] = [];

  for (const field of ["exports", "imports"] as const) {
    const entries = manifest[field];

    if (entries === undefined && field === "imports") {
      continue;
    }

    if (!isRecord(entries)) {
      problems.push(`${field} must be an object of entry points`);
      continue;
    }

    for (const [key, entry] of Object.entries(entries)) {
      problems.push(...entryProblems(field, key, entry));
    }
  }

  return problems;
};

const dependencyProblems = (manifest: PackageManifest): string[] => {
  const problems: string[] = [];

  for (const block of dependencyBlocks) {
    for (const [name, range] of Object.entries(manifest[block] ?? {})) {
      if (range === "latest" || range === "*") {
        problems.push(`${block}.${name} uses the floating range "${range}"`);
      }

      const pinsInternal =
        block === "dependencies" || block === "peerDependencies";

      if (pinsInternal && isInternal(name) && range !== "workspace:*") {
        problems.push(`${block}.${name} must be "workspace:*"`);
      }
    }
  }

  for (const name of sharedPeers) {
    if (manifest.dependencies?.[name] !== undefined) {
      problems.push(
        `dependencies.${name}: ${name} is a peer dependency, never a dependency`
      );
    }

    const peer = manifest.peerDependencies?.[name];

    if (peer !== undefined && manifest.devDependencies?.[name] !== peer) {
      problems.push(
        `peerDependencies.${name} needs the same entry in devDependencies`
      );
    }
  }

  return problems;
};

const metadataProblems = (manifest: PackageManifest): string[] => {
  const problems: string[] = [];
  const exportsField = isRecord(manifest.exports) ? manifest.exports : {};
  const rootExport = exportsField["."];
  const { files } = manifest;
  const publishConfig = isRecord(manifest.publishConfig)
    ? manifest.publishConfig
    : {};
  const engines = isRecord(manifest.engines) ? manifest.engines : {};
  const repository = isRecord(manifest.repository) ? manifest.repository : {};
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};

  if (!isRecord(rootExport) || manifest.types !== rootExport.types) {
    problems.push(`types must equal exports["."].types`);
  }

  if (
    !Array.isArray(files) ||
    files.length !== expectedFiles.length ||
    files.some((file, i) => file !== expectedFiles[i])
  ) {
    problems.push(`files must be ${JSON.stringify(expectedFiles)}`);
  }

  if (publishConfig.access !== "public") {
    problems.push(`publishConfig.access must be "public"`);
  }

  if (typeof manifest.license !== "string") {
    problems.push("license is missing");
  }

  if (typeof engines.bun !== "string") {
    problems.push("engines.bun is missing");
  }

  if (typeof repository.directory !== "string") {
    problems.push("repository.directory is missing");
  }

  if (
    typeof scripts.build !== "string" ||
    !scripts.build.startsWith("rm -rf dist")
  ) {
    problems.push(`scripts.build must start with "rm -rf dist"`);
  }

  if (
    typeof scripts.prepack !== "string" ||
    !scripts.prepack.includes("bun run build")
  ) {
    problems.push(`scripts.prepack must run "bun run build"`);
  }

  return problems;
};

/** What keeps a workspace manifest from being released at `version`. Empty when it is ready. */
export const manifestProblems = (
  manifest: PackageManifest,
  version: string
): string[] => {
  const problems: string[] = [];

  if (manifest.version !== version) {
    problems.push(
      `version ${String(manifest.version)} differs from voke's ${version}; every package moves in lockstep`
    );
  }

  if (!versionPattern.test(manifest.version ?? "")) {
    problems.push(`version ${String(manifest.version)} is not x.y.z`);
  }

  problems.push(
    ...dependencyProblems(manifest),
    ...conditionProblems(manifest),
    ...metadataProblems(manifest)
  );

  if (manifest.name === "voke") {
    const bin = isRecord(manifest.bin) ? manifest.bin : {};

    if (bin.voke !== "./src/cli.ts") {
      problems.push(`bin.voke must be "./src/cli.ts"`);
    }
  }

  return problems;
};

/** Every `types` target a manifest names: top level, `exports` and `imports`. */
const declarationTargets = (manifest: PackageManifest): string[] => {
  const targets = new Set<string>();

  if (typeof manifest.types === "string") {
    targets.add(manifest.types);
  }

  for (const field of ["exports", "imports"] as const) {
    const entries = manifest[field];

    if (!isRecord(entries)) {
      continue;
    }

    for (const entry of Object.values(entries)) {
      if (isRecord(entry) && typeof entry.types === "string") {
        targets.add(entry.types);
      }
    }
  }

  return [...targets];
};

const tarballPath = (target: string): string =>
  `package/${target.replace(/^\.\//u, "")}`;

/**
 * What is wrong with a packed tarball, given its `package/package.json` and the paths `tar -tzf`
 * lists. Empty when the tarball can be published.
 */
export const packedProblems = (
  manifest: PackageManifest,
  files: readonly string[],
  version: string
): string[] => {
  const problems: string[] = [];
  const present = new Set(files);

  for (const block of dependencyBlocks) {
    for (const [name, range] of Object.entries(manifest[block] ?? {})) {
      if (
        range.startsWith("workspace:") ||
        range.startsWith("catalog:") ||
        range === "latest" ||
        range === "*"
      ) {
        problems.push(`${block}.${name} kept the range "${range}"`);
      } else if (isInternal(name) && range !== version) {
        problems.push(`${block}.${name} is "${range}", expected "${version}"`);
      }
    }
  }

  const required = [
    "package/LICENSE",
    "package/README.md",
    "package/src/index.ts",
    ...declarationTargets(manifest).map(tarballPath),
  ];

  for (const file of required) {
    if (!present.has(file)) {
      problems.push(`${file} is missing`);
    }
  }

  for (const file of files) {
    if (file.startsWith("package/test/")) {
      problems.push(`${file} is a test file`);
    }

    if (
      file.startsWith("package/dist/") &&
      !file.endsWith(".d.ts") &&
      !file.endsWith(".d.ts.map")
    ) {
      problems.push(`${file} is not a declaration file`);
    }
  }

  return problems;
};

/** Replaces the `"version"` of a manifest's text; every other byte stays the same. */
export const withVersion = (manifestText: string, version: string): string => {
  assertVersion(version);

  if (!versionLinePattern.test(manifestText)) {
    throw new Error(`The manifest has no "version" field.`);
  }

  return manifestText.replace(
    versionLinePattern,
    (_line, prefix: string) => `${prefix}"${version}"`
  );
};

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** True when the changelog has a `## <version>` heading. */
export const changelogHasVersion = (
  changelog: string,
  version: string
): boolean =>
  new RegExp(`^## ${escapeRegExp(version)}(?:\\s|$)`, "mu").test(changelog);

/** Points each named package at a local tarball with `overrides`; `dependencies` stay as written. */
export const withTarballOverrides = (
  manifest: PackageManifest,
  tarballs: Readonly<Record<string, string>>
): PackageManifest => ({
  ...manifest,
  overrides: {
    ...manifest.overrides,
    ...Object.fromEntries(
      Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`])
    ),
  },
});

// ---------------------------------------------------------------------------------------------
// Commands. Everything below touches the file system or runs processes.
// ---------------------------------------------------------------------------------------------

const readManifest = async (directory: string): Promise<PackageManifest> =>
  JSON.parse(
    await readFile(join(repositoryRoot, directory, "package.json"), "utf-8")
  ) as PackageManifest;

export const currentVersion = async (): Promise<string> => {
  const { version } = await readManifest("packages/core");

  if (version === undefined) {
    throw new Error("packages/core/package.json has no version.");
  }

  return version;
};

/** Doc lines that name the version, rewritten by `version`. */
const versionedDocs = [
  {
    path: "apps/docs/content/docs/reference/cli.mdx",
    patterns: (version: string) => [`Voke v${version}`, `voke ${version}`],
  },
  {
    path: "apps/docs/content/docs/reference/packages.mdx",
    patterns: (version: string) => [`\`${version}\``],
  },
] as const;

const run = async (command: string[], cwd: string): Promise<string> => {
  const child = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed in ${cwd} with exit code ${exitCode}\n${stdout}${stderr}`
    );
  }

  return stdout;
};

/** Files `prepack` copies into package directories; removed after every pack. */
const prepackCopies = [
  ...publishedPackages.map(({ directory }) => join(directory, "LICENSE")),
  "packages/core/README.md",
];

const removePrepackCopies = async (): Promise<void> => {
  await Promise.all(
    prepackCopies.map((path) => rm(join(repositoryRoot, path), { force: true }))
  );
};

export interface PackedTarball {
  name: string;
  path: string;
  size: number;
}

/**
 * Packs every published package into `outDir` (emptied first) and verifies each tarball. Throws
 * with every problem found; the package directories are left as they were.
 */
export const packPackages = async (
  outDir: string
): Promise<PackedTarball[]> => {
  const version = await currentVersion();
  const problems: string[] = [];
  const tarballs: PackedTarball[] = [];

  await rm(outDir, { force: true, recursive: true });
  await mkdir(outDir, { recursive: true });

  try {
    for (const { directory, name } of publishedPackages) {
      const manifest = await readManifest(directory);
      const before = manifestProblems(manifest, version);

      if (before.length > 0) {
        problems.push(...before.map((problem) => `${name}: ${problem}`));
        continue;
      }

      const cwd = join(repositoryRoot, directory);
      const printed = await run(
        ["bun", "pm", "pack", "--destination", outDir, "--quiet"],
        cwd
      );
      const path = resolve(cwd, printed.trim().split("\n").at(-1) ?? "");
      const listing = await run(["tar", "-tzf", path], outDir);
      const files = listing
        .split("\n")
        .filter((line) => line !== "" && !line.endsWith("/"));
      const packed = JSON.parse(
        await run(["tar", "-xzOf", path, "package/package.json"], outDir)
      ) as PackageManifest;

      problems.push(
        ...packedProblems(packed, files, version).map(
          (problem) => `${basename(path)}: ${problem}`
        )
      );
      const { size } = await stat(path);

      tarballs.push({ name, path, size });
    }
  } finally {
    await removePrepackCopies();
  }

  if (problems.length > 0) {
    throw new Error(
      `The packages are not ready to publish:\n- ${problems.join("\n- ")}`
    );
  }

  return tarballs;
};

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/** A path relative to the working directory when it is inside it, absolute otherwise. */
const shownPath = (path: string): string => {
  const shown = relative(process.cwd(), path);

  return shown.startsWith("..") ? path : shown;
};

const versionCommand = async (version: string | undefined): Promise<void> => {
  if (version === undefined) {
    throw new Error("Usage: bun scripts/release.ts version <x.y.z>");
  }

  assertVersion(version);

  const changelog = await readFile(
    join(repositoryRoot, "CHANGELOG.md"),
    "utf-8"
  );

  if (!changelogHasVersion(changelog, version)) {
    throw new Error(`Add a "## ${version}" section to CHANGELOG.md first.`);
  }

  const previous = await currentVersion();
  const changed: string[] = [];

  for (const { directory } of publishedPackages) {
    const path = join(repositoryRoot, directory, "package.json");
    const text = await readFile(path, "utf-8");
    const next = withVersion(text, version);

    if (next !== text) {
      await writeFile(path, next);
      changed.push(relative(repositoryRoot, path));
    }
  }

  for (const doc of versionedDocs) {
    const path = join(repositoryRoot, doc.path);
    const text = await readFile(path, "utf-8");
    const nextPatterns = doc.patterns(version);
    let next = text;

    for (const [i, pattern] of doc.patterns(previous).entries()) {
      next = next.replaceAll(pattern, nextPatterns[i] ?? pattern);
    }

    if (next !== text) {
      await writeFile(path, next);
      changed.push(doc.path);
    }
  }

  // CI installs with --frozen-lockfile, so bun.lock must record the new workspace versions.
  await run(["bun", "install"], repositoryRoot);
  changed.push("bun.lock");

  console.log(`Set version ${version} (was ${previous}). Changed:`);

  for (const path of changed) {
    console.log(`  ${path}`);
  }
};

const packCommand = async (args: readonly string[]): Promise<void> => {
  const outIndex = args.indexOf("--out");
  const version = await currentVersion();
  const outDir = resolve(
    outIndex === -1
      ? join(repositoryRoot, ".release", version)
      : (args[outIndex + 1] ?? "")
  );
  const tarballs = await packPackages(outDir);

  for (const tarball of tarballs) {
    console.log(`${shownPath(tarball.path)}  ${kilobytes(tarball.size)}`);
  }

  console.log("\nVerified. To publish, the owner runs, in order:");

  for (const tarball of tarballs) {
    console.log(`  bun publish ${shownPath(tarball.path)} --access public`);
  }
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  try {
    if (command === "version") {
      await versionCommand(args[0]);
    } else if (command === "pack") {
      await packCommand(args);
    } else {
      throw new Error(
        "Usage: bun scripts/release.ts version <x.y.z> | pack [--out <dir>]"
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
