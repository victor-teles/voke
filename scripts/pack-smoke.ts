// Packs the published packages, installs them from the tarballs into a fresh Voke Project, and
// proves that project type-checks (with the Project Starter's tsconfig and a stricter one), passes
// its test and builds a Lambda Bundle: `bun run smoke:pack [--keep]`.
//
// Third-party packages come from the registry; Voke's own packages come only from the tarballs.
// Nothing here publishes, and no command reaches AWS (`voke doctor`, `deploy`, `local` and
// `remove` are never run).
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentVersion,
  packPackages,
  publishedPackages,
  withTarballOverrides,
} from "./release";
import type { PackageManifest } from "./release";

/** Strings that only deploy-time code contains; the Lambda Bundle must not (see examples/hello-api/test/bundle.test.ts). */
const deployTimeMarkers = [
  "AWSTemplateFormatVersion",
  "@aws-sdk/client-cloudformation",
];

const sourcePathPattern = /node_modules\/(?:voke|@voke\/[a-z]+)\/src\//u;
const declarationPathPattern = /node_modules\/(?:voke|@voke\/[a-z]+)\/dist\//u;

const strictFlags = [
  "exactOptionalPropertyTypes",
  "noPropertyAccessFromIndexSignature",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "noImplicitReturns",
  "noUnusedLocals",
  "noUnusedParameters",
  "noFallthroughCasesInSwitch",
] as const;

/** One import from every entry point, each used once, so all of them load and type-check. */
const allPackagesModule = `import { created } from "@voke/http";
import { idempotent } from "@voke/idempotency";
import { openapi } from "@voke/openapi";
import { createRemoteFunctions } from "@voke/remote";
import { schema } from "@voke/schema";
import { createTestClient } from "@voke/testing";
import { aws } from "@voke/aws";
import { sqsQueue } from "@voke/aws/cloudformation";
import { createLocalWorkflow } from "@voke/aws/local";
import { runDurable } from "@voke/aws/testing";
import { createBuildPlan } from "@voke/build";
import { defineConfig } from "voke";

const entryPoints = {
  "@voke/aws": aws,
  "@voke/aws/cloudformation": sqsQueue,
  "@voke/aws/local": createLocalWorkflow,
  "@voke/aws/testing": runDurable,
  "@voke/build": createBuildPlan,
  "@voke/http": created,
  "@voke/idempotency": idempotent,
  "@voke/openapi": openapi,
  "@voke/remote": createRemoteFunctions,
  "@voke/schema": schema,
  "@voke/testing": createTestClient,
  voke: defineConfig,
};

for (const [name, value] of Object.entries(entryPoints)) {
  if (value === undefined) {
    throw new Error(\`\${name} did not load\`);
  }
}

console.log(\`loaded \${Object.keys(entryPoints).length} entry points\`);
`;

const nodeImportCheck =
  "const m = await import('./dist/index.js'); if (typeof m.http !== 'function') process.exit(1)";

class SmokeFailureError extends Error {
  override name = "SmokeFailureError";
}

const run = async (
  step: string,
  command: string[],
  cwd: string
): Promise<string> => {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new SmokeFailureError(
      `${step}: \`${command.join(" ")}\` exited with code ${exitCode}\n${stdout}${stderr}`
    );
  }

  return stdout;
};

const check = (step: string, ok: boolean, message: string): void => {
  if (!ok) {
    throw new SmokeFailureError(`${step}: ${message}`);
  }
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf-8")) as T;

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** Paths of every installed package.json named `name`, as real directories (symlinks are skipped). */
const installedCopies = async (
  directory: string,
  name: string,
  depth: number
): Promise<string[]> => {
  const found: string[] = [];
  const manifest = join(directory, "package.json");

  if (await Bun.file(manifest).exists()) {
    const { name: installed } = await readJson<{ name?: string }>(manifest);

    if (installed === name) {
      found.push(manifest);
    }
  }

  if (depth === 0) {
    return found;
  }

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);

    // A Dirent describes the entry itself, so a symlinked package is not a directory here.
    if (entry.isDirectory()) {
      found.push(...(await installedCopies(child, name, depth - 1)));
    }
  }

  return found;
};

const smoke = async (workDirectory: string): Promise<void> => {
  const version = await currentVersion();

  // Step 2: the same code path and checks as `bun scripts/release.ts pack`.
  console.log("pack: packing the published packages");
  const tarballs = await packPackages(join(workDirectory, "tarballs")).catch(
    (error: unknown) => {
      throw new SmokeFailureError(
        `pack: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  );
  const tarballOf = Object.fromEntries(
    tarballs.map(({ name, path }) => [name, path])
  );

  // Step 3: what `bunx voke create` does: install only `voke` (and its peers), run its binary.
  console.log("launcher: voke create smoke-api");
  const launcher = join(workDirectory, "launcher");

  await mkdir(launcher, { recursive: true });
  await writeJson(join(launcher, "package.json"), {
    dependencies: { voke: `file:${tarballOf.voke}` },
    name: "launcher",
    private: true,
  });
  await run("launcher", ["bun", "install"], launcher);
  await run(
    "launcher",
    ["./node_modules/.bin/voke", "create", "smoke-api", "--no-install"],
    launcher
  );

  // Step 4: install every package from its tarball.
  console.log("install: the nine packages from their tarballs");
  const project = join(launcher, "smoke-api");
  const manifestPath = join(project, "package.json");
  const starter = await readJson<PackageManifest>(manifestPath);
  const extraPackages = publishedPackages
    .map(({ name }) => name)
    .filter((name) => starter.dependencies?.[name] === undefined);

  await writeJson(
    manifestPath,
    withTarballOverrides(
      {
        ...starter,
        dependencies: {
          ...starter.dependencies,
          ...Object.fromEntries(
            extraPackages.map((name) => [name, `^${version}`])
          ),
        },
      },
      tarballOf
    )
  );
  await run("install", ["bun", "install"], project);

  // Step 5: one copy of core, so `instanceof` and module state hold across packages.
  const copies = await installedCopies(
    join(project, "node_modules"),
    "voke",
    5
  );

  check(
    "one copy of voke",
    copies.length === 1,
    `expected one installed voke, found ${copies.length}: ${copies.join(", ")}`
  );

  // Step 6: every entry point loads under Bun.
  console.log("load: every entry point under Bun");
  await writeFile(join(project, "src/all-packages.ts"), allPackagesModule);
  await run("load", ["bun", "src/all-packages.ts"], project);

  // Step 7: the Project Starter's tsconfig.
  console.log("typecheck: the Project Starter's tsconfig");
  await run("typecheck", ["bun", "run", "typecheck"], project);

  // Step 8: a stricter tsconfig. Voke's flags must not leak into the project.
  console.log(`typecheck: a stricter tsconfig (${strictFlags.join(", ")})`);
  await writeJson(join(project, "tsconfig.strict.json"), {
    compilerOptions: Object.fromEntries(
      strictFlags.map((flag) => [flag, true])
    ),
    extends: "./tsconfig.json",
  });
  await run(
    "strict typecheck",
    ["bunx", "tsgo", "--project", "tsconfig.strict.json", "--noEmit"],
    project
  );

  // Step 9: the structural reason step 8 holds: the compiler reads declarations, never Voke's source.
  const listing = await run(
    "declarations only",
    ["bunx", "tsgo", "--project", "tsconfig.json", "--noEmit", "--listFiles"],
    project
  );
  const listed = listing.split("\n");
  const sourceFiles = listed.filter((line) => sourcePathPattern.test(line));

  check(
    "declarations only",
    sourceFiles.length === 0,
    `the compiler read Voke source files:\n${sourceFiles.join("\n")}`
  );
  check(
    "declarations only",
    listed.some((line) => declarationPathPattern.test(line)),
    "the compiler read no Voke declaration file"
  );

  // Step 10: the starter's own test.
  console.log("test: bun test");
  await run("test", ["bun", "test"], project);

  // Step 11: `voke build`, with `#provider` resolved through `voke-runtime` from the tarball.
  console.log("build: voke build");
  await run("build", ["bun", "run", "build"], project);
  const bundlePath = join(project, "dist/index.js");

  check(
    "build",
    await Bun.file(bundlePath).exists(),
    "dist/index.js was not written"
  );
  const bundle = await Bun.file(bundlePath).text();
  const leaked = deployTimeMarkers.filter((marker) => bundle.includes(marker));

  check(
    "build",
    leaked.length === 0,
    `the Lambda Bundle contains deploy-time code: ${leaked.join(", ")}`
  );

  if (Bun.which("node") === null) {
    console.log("node: skipped, node is not installed");
  } else {
    console.log("node: import dist/index.js");
    await run(
      "node",
      ["node", "--input-type=module", "-e", nodeImportCheck],
      project
    );
  }
};

const keep = process.argv.includes("--keep");
const workDirectory = await mkdtemp(join(tmpdir(), "voke-pack-smoke-"));

try {
  await smoke(workDirectory);
  console.log("pack smoke: ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (keep) {
    console.log(`kept ${workDirectory}`);
  } else {
    await rm(workDirectory, { force: true, recursive: true });
  }
}
