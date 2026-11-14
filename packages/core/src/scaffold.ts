import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import packageJson from "../package.json";
import { CliUsageError } from "./cli-spec";
import { defaultDevPort } from "./dev";
import { VokeError } from "./errors";

export interface CreateApiProjectOptions {
  name: string;
  directory?: string;
  /** Write into a non-empty directory. Starter files are overwritten; other files are kept. */
  force?: boolean;
}

type ScaffoldRunner = (
  command: string[],
  options?: { cwd?: string }
) => void | Promise<void>;

export interface CreateProjectOptions extends CreateApiProjectOptions {
  /** Run `bun install` in the new project. Default true. */
  install?: boolean;
  output: (message: string) => void;
  run: ScaffoldRunner;
}

// Every Voke package moves in lockstep, so the starter pins all of them to the CLI's own version.
const vokeDependencies = ["@voke/aws", "@voke/testing", "voke"] as const;
// Matches the root package.json catalog entry.
const typescriptNativePreviewVersion = "^7.0.0-dev.20260516.1";
const maxPackageNameLength = 214;
const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

const assertPackageName = (name: string): void => {
  if (name.length <= maxPackageNameLength && packageNamePattern.test(name)) {
    return;
  }

  throw new CliUsageError(
    `Invalid project name "${name}". Use lowercase letters, digits, "-", "." or "_", optionally with a scope: my-api or @acme/my-api`
  );
};

/** `@acme/orders` → `orders`. */
export const unscopedName = (name: string): string =>
  name.startsWith("@") ? (name.split("/")[1] ?? name) : name;

const testTemplate = `import { expect, test } from "bun:test";
import { createTestClient } from "@voke/testing";

import service from "../src/index";

test("responds to health checks", async () => {
  const client = createTestClient(service);
  const response = await client.get("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
});
`;

const healthRouteTemplate = `import { route } from "voke";

export const healthRoute = route.get("/health", {
  handler: () => ({ ok: true }),
});
`;

const vokeConfigTemplate = (
  name: string
): string => `import { aws } from "@voke/aws";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/index.ts",
  name: ${JSON.stringify(name)},
  provider: aws(),
});
`;

const indexTemplate = `import { createFunctions, http, voke } from "voke";

import config from "../voke.config";
import { healthRoute } from "./routes/health";

const functions = createFunctions({
  http: http({
    routes: [healthRoute],
  }),
});

export default voke(functions, { config });
`;

const gitignoreTemplate = `node_modules
dist
.voke
.env*
coverage
`;

const readmeTemplate = (name: string): string => `# ${name}

A Voke API.

\`\`\`bash
bun run dev      # local API with hot reload
bun test         # run the tests
bun run deploy   # deploy the dev stage to AWS
bun run remove   # delete the dev stage
\`\`\`
`;

const tsconfig = {
  compilerOptions: {
    allowImportingTsExtensions: true,
    lib: ["ESNext", "DOM"],
    module: "Preserve",
    moduleDetection: "force",
    moduleResolution: "bundler",
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: "ESNext",
    types: ["bun"],
    verbatimModuleSyntax: true,
  },
  include: ["voke.config.ts", "src/**/*.ts", "test/**/*.ts"],
};

const projectPackageJson = (name: string): Record<string, unknown> => ({
  dependencies: {
    ...Object.fromEntries(
      vokeDependencies.map((dependency) => [
        dependency,
        `^${packageJson.version}`,
      ])
    ),
    hono: "^4.0.0",
  },
  devDependencies: {
    "@types/bun": "latest",
    "@typescript/native-preview": typescriptNativePreviewVersion,
  },
  name,
  private: true,
  scripts: {
    build: "voke build",
    clean: "rm -rf dist coverage",
    deploy: "voke deploy --stage dev",
    dev: "voke dev",
    local: "voke local start",
    remove: "voke remove --stage dev",
    synth: "voke synth",
    test: "bun test",
    typecheck: "bunx tsgo --project tsconfig.json --noEmit",
  },
  type: "module",
  version: "0.0.0",
});

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const assertWritableDirectory = async (
  directory: string,
  force: boolean
): Promise<void> => {
  let entries: string[];

  try {
    entries = await readdir(directory);
  } catch {
    return;
  }

  if (entries.length > 0 && !force) {
    throw new CliUsageError(
      `Directory ${directory} is not empty. Choose another directory, or pass --force to write the starter files into it.`
    );
  }
};

/** Writes the API starter and returns its directory. */
export const createApiProject = async (
  options: CreateApiProjectOptions
): Promise<string> => {
  assertPackageName(options.name);

  const directory = options.directory ?? `./${unscopedName(options.name)}`;
  const files: Record<string, string> = {
    ".gitignore": gitignoreTemplate,
    "README.md": readmeTemplate(options.name),
    "package.json": json(projectPackageJson(options.name)),
    "src/index.ts": indexTemplate,
    "src/routes/health.ts": healthRouteTemplate,
    "test/api.test.ts": testTemplate,
    "tsconfig.json": json(tsconfig),
    "voke.config.ts": vokeConfigTemplate(unscopedName(options.name)),
  };

  await assertWritableDirectory(directory, options.force === true);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return directory;
};

const displayPath = (directory: string): string => {
  const path = relative(process.cwd(), resolve(directory));

  return path.startsWith("..") || path === "" ? directory : `./${path}`;
};

/** `voke create`: writes the starter, installs dependencies, and prints the next steps. */
export const createProject = async (
  options: CreateProjectOptions
): Promise<string> => {
  const directory = await createApiProject(options);
  const shown = displayPath(directory);
  const cd = `cd ${shown.startsWith("./") ? shown.slice(2) : shown}`;

  if (options.install !== false) {
    try {
      await options.run(["bun", "install"], { cwd: directory });
    } catch (error) {
      throw new VokeError(
        `Created ${options.name} in ${shown}, but bun install failed. Install the dependencies with: ${cd} && bun install`,
        { cause: error, code: "CREATE_ERROR" }
      );
    }
  }

  options.output(
    [
      `Created ${options.name} in ${shown}`,
      "",
      "Next steps:",
      `  ${cd}`,
      ...(options.install === false ? ["  bun install"] : []),
      `  bun run dev        # local API on http://localhost:${defaultDevPort}`,
      "  bun test",
      "  bun run deploy     # deploy the dev stage to AWS",
    ].join("\n")
  );

  return directory;
};
