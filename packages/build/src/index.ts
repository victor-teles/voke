import { functionRegistryEntries } from "voke";
import type {
  BuildPlan,
  BuildPlanFunction,
  BuildPlanOutput,
  FunctionRegistry,
  FunctionRegistryInput,
  VokeBuildConfig,
} from "voke";

export interface BaseBuildPlanInput {
  build: VokeBuildConfig;
  /** Bundle entrypoints before any explicit per-Function `synthesis.entrypoint`s are added. */
  entrypoints: readonly string[];
  functions: FunctionRegistry | FunctionRegistryInput;
  /** Generated source files the entrypoints depend on, written before the bundler runs. */
  sources?: Record<string, string>;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

// Build paths become bundle paths and Lambda handler names, which always use "/". Windows
// separators in config are converted, so the plan is the same on every platform.
const normalize = (path: string): string =>
  path
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");

const directoryOf = (path: string): string[] =>
  normalize(path).split("/").slice(0, -1);

/** The deepest directory shared by every entrypoint; Bun writes outputs relative to it. */
const commonRoot = (entrypoints: readonly string[]): string[] => {
  const [first = [], ...rest] = entrypoints.map(directoryOf);

  return first.filter((segment, index) =>
    rest.every((directory) => directory[index] === segment)
  );
};

const toOutputFile = (
  entrypoint: string,
  root: readonly string[],
  outdir: string
): string => {
  const relative = normalize(entrypoint).split("/").slice(root.length).join("/");

  return `${normalize(outdir)}/${relative.replace(/\.[^./]+$/u, ".js")}`;
};

/**
 * The Lambda handler module for a bundle file: its path relative to the build output directory,
 * without the ".js" extension ("dist/jobs/report.js" -> "jobs/report").
 */
export const handlerModule = (file: string, outdir: string): string =>
  file
    .slice(normalize(outdir).length + 1)
    .replace(/\.js$/u, "");

/**
 * The package condition every Lambda Bundle is built with. A package resolves its run-time half
 * through it in its `package.json` `exports` or `imports`, so deploy-time code stays out of the
 * bundle, as `@voke/aws` does for `aws()`. A public contract: docs/adr/0022-runtime-only-lambda-bundle.md.
 */
const runtimeCondition = "voke-runtime";

/**
 * The provider-neutral build plan: one Node.js ESM bundle per entrypoint, resolved with the
 * `voke-runtime` condition and minified without renaming identifiers, the AWS SDK and other
 * `build.external` modules left out, and a sibling package.json so Node loads the bundle as ESM.
 * Functions with an explicit `synthesis.entrypoint` get their own bundle entry and handler.
 */
export const createBuildPlan = (input: BaseBuildPlanInput): BuildPlan => {
  const { outdir } = input.build;
  const explicitFunctions = functionRegistryEntries(input.functions).filter(
    ([, definition]) => definition.synthesis?.entrypoint !== undefined
  );
  const entrypoints = unique([
    ...input.entrypoints,
    ...explicitFunctions.map(
      ([, definition]) => definition.synthesis?.entrypoint as string
    ),
  ]);
  const root = commonRoot(entrypoints);
  const outputs: Record<string, BuildPlanOutput> = Object.fromEntries(
    entrypoints.map((entrypoint) => [
      entrypoint,
      { file: toOutputFile(entrypoint, root, outdir) },
    ])
  );
  const functions: Record<string, BuildPlanFunction> = Object.fromEntries(
    explicitFunctions.map(([key, definition]) => {
      const entrypoint = definition.synthesis?.entrypoint as string;
      const file = outputs[entrypoint]?.file ?? "";

      return [
        key,
        {
          file,
          handler:
            definition.synthesis?.handler ??
            `${handlerModule(file, outdir)}.handler`,
        },
      ];
    })
  );

  return {
    command: [
      "bun",
      "build",
      ...entrypoints,
      "--outdir",
      outdir,
      "--target",
      "node",
      "--format",
      "esm",
      "--conditions",
      runtimeCondition,
      // Names stay as written so a stack frame still reads `at chargeCard (index.js:1:51234)`;
      // identifiers are never renamed, and no source map is written (docs/adr/0022-runtime-only-lambda-bundle.md).
      "--minify-whitespace",
      "--minify-syntax",
      ...input.build.external.flatMap((pattern) => ["--external", pattern]),
    ],
    entrypoints,
    // The bundle is ESM in a .js file; a sibling package.json with "type": "module"
    // tells the Lambda Node.js runtime to load it as an ES module.
    files: {
      [`${normalize(outdir)}/package.json`]: `${JSON.stringify({ type: "module" })}\n`,
    },
    manifest: { functions },
    outdir,
    outputs,
    sources: { ...input.sources },
  };
};
