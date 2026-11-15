// CLI-time only: discovers the Function Registry by importing the project entrypoint.
import type { VokeConfig } from "./config";
import { VokeConfigError } from "./errors";
import { functionRegistryEntries } from "./invoke";
import type { FunctionRegistry, FunctionRegistryInput } from "./invoke";
import { projectFunctionEntries } from "./plugin";
import { readEnv } from "./runtime-env";

export interface LoadedProject {
  config: VokeConfig;
  /** The project entrypoint the registry was imported from, as an absolute path. */
  entrypoint: string;
  /** The project's Functions, plus the Plugin-contributed ones when the config has any. */
  functions: FunctionRegistry | FunctionRegistryInput;
}

export const missingProjectExportMessage =
  "The project entrypoint must export a Gateway (export default voke(functions, { config })) or a Function Registry (export const functions = createFunctions({ ... })).";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGateway = (
  value: unknown
): value is { functions: FunctionRegistry; app: unknown; config: unknown } =>
  isObject(value) &&
  "app" in value &&
  "config" in value &&
  isObject(value.functions);

const isRegistry = (value: unknown): value is FunctionRegistry =>
  isObject(value) && functionRegistryEntries(value).length > 0;

/**
 * Finds the Function Registry a project entrypoint module exports: the Gateway's registry when the
 * default export is a Gateway, otherwise the `functions` export.
 */
export const resolveProjectFunctions = (
  module: Record<string, unknown>
): FunctionRegistry | undefined => {
  if (isGateway(module.default)) {
    return module.default.functions;
  }

  if (isRegistry(module.functions)) {
    return module.functions;
  }

  return undefined;
};

const toAbsolutePath = (path: string, cwd: string): string => {
  if (path.startsWith("/")) {
    return path;
  }

  const relative = path.startsWith("./") ? path.slice(2) : path;

  return `${cwd.replace(/\/+$/u, "")}/${relative}`;
};

const importWithSynthFlag = async (
  url: string
): Promise<Record<string, unknown>> => {
  const previous = process.env.VOKE_SYNTH;
  process.env.VOKE_SYNTH = "1";

  try {
    return (await import(url)) as Record<string, unknown>;
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "VOKE_SYNTH");
    } else {
      process.env.VOKE_SYNTH = previous;
    }
  }
};

/**
 * Imports the project entrypoint to discover its Functions. `process.env.VOKE_SYNTH` is "1" while
 * the module loads, so entrypoints can skip side effects (servers, connections) during synth/build.
 */
export const loadProject = async (options: {
  config: VokeConfig;
  cwd?: string;
  entrypoint?: string;
}): Promise<LoadedProject> => {
  const cwd = options.cwd ?? readEnv("PWD") ?? ".";
  const entrypoint = toAbsolutePath(
    options.entrypoint ?? options.config.entrypoint,
    cwd
  );
  let module: Record<string, unknown>;

  try {
    module = await importWithSynthFlag(new URL(`file://${entrypoint}`).href);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new VokeConfigError(
      `Could not import the project entrypoint ${entrypoint}: ${reason}. Voke imports your entrypoint to discover Functions; guard side effects with process.env.VOKE_SYNTH.`,
      { cause: error }
    );
  }

  const functions = resolveProjectFunctions(module);

  if (functions === undefined) {
    throw new VokeConfigError(`${entrypoint}: ${missingProjectExportMessage}`);
  }

  const entries = projectFunctionEntries(functions, options.config);

  return {
    config: options.config,
    entrypoint,
    // With Plugin Functions, a plain record of every Function, so build, deploy and synth see them.
    functions:
      entries.length === functionRegistryEntries(functions).length
        ? functions
        : Object.fromEntries(entries),
  };
};
