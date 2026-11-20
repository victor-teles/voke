// Run-time module: bundled into deployed Functions, so it must not import CLI code.
import type { MiddlewareHandler } from "hono";

import type { VokeConfig, VokeResourceInput } from "./config";
import type { VokeEnv } from "./context";
import { VokeConfigError } from "./errors";
import type { VokeIssue } from "./errors";
import { functionRegistryEntries } from "./invoke";
import type {
  AnyFunctionDefinition,
  FunctionRegistry,
  FunctionRegistryInput,
  InvokeContext,
  RouteFunctionDefinition,
} from "./invoke";
import type { VokeModelProviderExtensionRecord } from "./model";

export type FunctionExecutionKind =
  | "authorizer"
  | "event"
  | "invokable"
  | "route";

/** One handler call, as a Function Wrap sees it. */
export interface FunctionExecution {
  readonly kind: FunctionExecutionKind;
  /** The Function Registry key. */
  readonly functionKey: string;
  /** What the handler receives: the parsed payload, route request, event or authorizer request. */
  readonly input: unknown;
  readonly context: InvokeContext;
  /** `"GET /users/:id"` for a route execution. */
  readonly route?: string;
}

/**
 * Runs around one handler call. `next()` calls the next wrap or the handler and resolves to the
 * handler's result before output validation. Returning without calling `next()` short-circuits.
 */
export type FunctionWrap = (
  execution: FunctionExecution,
  next: () => Promise<unknown>
) => Promise<unknown>;

export interface PluginRuntimeInput {
  readonly config: VokeConfig;
  /** True only under `voke dev`. */
  readonly dev: boolean;
  /** Every Function of the Gateway: the project's, then the Plugin-contributed ones. */
  readonly functions: readonly (readonly [string, AnyFunctionDefinition])[];
}

export interface PluginRuntimeHooks {
  /** Gateway middleware, registered after CORS and before `voke(functions, { middleware })`. */
  readonly middleware?: readonly MiddlewareHandler<VokeEnv>[];
  readonly wrap?: FunctionWrap;
}

export interface PluginRuntimeCapability {
  /** Called once, when the Gateway is composed. */
  setup: (input: PluginRuntimeInput) => PluginRuntimeHooks | undefined;
}

export interface PluginContributions {
  /** Environment variables set on every deployed Function. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Route-backed Functions only in v1, keyed by a short name. The registry key is `<plugin>-<name>`. */
  readonly functions?: Readonly<Record<string, RouteFunctionDefinition>>;
  /** One Provider Extension Record per Provider name. */
  readonly provider?: Readonly<
    Record<string, VokeModelProviderExtensionRecord>
  >;
  readonly resources?: Readonly<Record<string, VokeResourceInput>>;
}

export interface CliFlagSpec {
  description: string;
  /** Takes no value: `--yes` means true. */
  boolean?: boolean;
}

/** One argument a command takes, in order. An argument beyond the declared ones is rejected. */
export interface CliPositionalSpec {
  /** The word shown in `usage`, for example "entrypoint". */
  name: string;
  /** The only accepted values, for a subcommand position. */
  choices?: readonly string[];
  /** The flag that sets the same value; passing both is an error. */
  flag?: string;
  required?: boolean;
}

export interface PluginCommandInput {
  readonly config: VokeConfig;
  readonly cwd: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly positional: readonly string[];
  readonly output: (line: string) => void;
  /** Imports the project entrypoint; includes Plugin-contributed Functions. */
  readonly loadFunctions: () => Promise<
    readonly (readonly [string, AnyFunctionDefinition])[]
  >;
}

export interface PluginCommand {
  readonly description: string;
  readonly usage: string;
  readonly flags?: Readonly<Record<string, CliFlagSpec>>;
  /** The arguments the command takes, passed to `run` as `positional`. Omitted: none. */
  readonly positionals?: readonly CliPositionalSpec[];
  readonly run: (input: PluginCommandInput) => Promise<void>;
}

export interface PluginCliCapability {
  readonly description: string;
  readonly commands: Readonly<Record<string, PluginCommand>>;
}

/** A named unit declared in `voke.config.ts` that extends a Voke Project at run time and deploy time. */
export interface VokePlugin {
  readonly name: string;
  readonly cli?: PluginCliCapability;
  readonly contributions?: PluginContributions;
  readonly runtime?: PluginRuntimeCapability;
}

/** Built-in `voke` commands; a Plugin with `cli` cannot take one of these names. */
export const reservedPluginCommandNames: readonly string[] = [
  "build",
  "create",
  "deploy",
  "dev",
  "doctor",
  "help",
  "local",
  "migrate",
  "remote",
  "remove",
  "synth",
];

const pluginNamePattern = /^[a-z][a-z0-9-]*$/u;
const pluginFunctionNamePattern = /^[a-z][A-Za-z0-9]*$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const pluginFunctionIssues = (plugin: VokePlugin): VokeIssue[] => {
  const issues: VokeIssue[] = [];

  for (const [name, definition] of Object.entries(
    plugin.contributions?.functions ?? {}
  )) {
    const path = `plugins.${plugin.name}.contributions.functions.${name}`;

    if (!pluginFunctionNamePattern.test(name)) {
      issues.push({
        message: `expected a Function name matching ${pluginFunctionNamePattern.source}; received ${JSON.stringify(name)}`,
        path,
      });
    }

    const kind: unknown = isObject(definition) ? definition.kind : undefined;

    if (kind !== "route") {
      issues.push({
        message: `expected a route-backed Function from http(); received ${JSON.stringify(kind ?? null)}. Plugins contribute route-backed Functions only in v1`,
        path: `${path}.kind`,
      });
    }
  }

  return issues;
};

const pluginIssues = (plugins: readonly VokePlugin[]): VokeIssue[] => {
  const issues: VokeIssue[] = [];
  const names = new Set<string>();

  for (const [index, plugin] of plugins.entries()) {
    const name: unknown = isObject(plugin) ? plugin.name : undefined;

    if (typeof name !== "string" || !pluginNamePattern.test(name)) {
      issues.push({
        message: `expected a Plugin name matching ${pluginNamePattern.source}; received ${JSON.stringify(name ?? null)}`,
        path: `plugins.${index}.name`,
      });
      continue;
    }

    if (names.has(name)) {
      issues.push({
        message: `expected unique Plugin names; received ${JSON.stringify(name)} more than once`,
        path: `plugins.${index}.name`,
      });
    }

    names.add(name);

    if (plugin.cli !== undefined && reservedPluginCommandNames.includes(name)) {
      issues.push({
        message: `expected a Plugin name that is not a built-in command when the Plugin declares cli; received ${JSON.stringify(name)}`,
        path: `plugins.${index}.name`,
      });
    }

    issues.push(...pluginFunctionIssues(plugin));
  }

  return issues;
};

/** Validates the Plugins of a config and returns them as a new array. */
export const definePlugins = (
  plugins: readonly VokePlugin[] | undefined
): VokePlugin[] => {
  const list = [...(plugins ?? [])];
  const issues = pluginIssues(list);

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return list;
};

/**
 * Adds each Plugin's `resources` or `environment` contribution to the project's own. A key that
 * already holds an equal value (the same resource object, the same string) is not a conflict, so
 * normalizing a normalized config gives the same result.
 */
export const mergePluginContributions = <TValue>(
  kind: "environment" | "resources",
  base: Readonly<Record<string, TValue>> | undefined,
  plugins: readonly VokePlugin[]
): Record<string, TValue> => {
  const merged: Record<string, TValue> = { ...base };
  const issues: VokeIssue[] = [];

  for (const plugin of plugins) {
    const contributed = (plugin.contributions?.[kind] ?? {}) as Readonly<
      Record<string, TValue>
    >;

    for (const [key, value] of Object.entries(contributed)) {
      if (key in merged && merged[key] !== value) {
        issues.push({
          message: `expected a ${kind === "resources" ? "resource" : "environment variable"} key the project and other Plugins do not use; received ${JSON.stringify(key)}`,
          path: `plugins.${plugin.name}.contributions.${kind}.${key}`,
        });
        continue;
      }

      merged[key] = value;
    }
  }

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return merged;
};

// One frozen, keyed copy per contributed definition, so every caller (Gateway, model, Lambda
// handlers) sees the same object; activation is stored per definition object.
const pluginFunctionCopies = new WeakMap<object, AnyFunctionDefinition>();

const keyedPluginFunction = (
  key: string,
  definition: RouteFunctionDefinition
): AnyFunctionDefinition => {
  const cached = pluginFunctionCopies.get(definition);

  if (cached !== undefined) {
    return cached;
  }

  const copy = Object.freeze({
    ...(definition as unknown as AnyFunctionDefinition),
    key,
  });

  pluginFunctionCopies.set(definition, copy);

  return copy;
};

interface PluginFunctionEntry {
  readonly definition: AnyFunctionDefinition;
  readonly key: string;
  readonly name: string;
  readonly plugin: string;
}

/** The Functions Plugins contribute, keyed `<plugin name>-<function name>`. */
const pluginFunctionEntries = (
  plugins: readonly VokePlugin[]
): PluginFunctionEntry[] =>
  plugins.flatMap((plugin) =>
    Object.entries(plugin.contributions?.functions ?? {}).map(
      ([name, definition]) => {
        const key = `${plugin.name}-${name}`;

        return {
          definition: keyedPluginFunction(key, definition),
          key,
          name,
          plugin: plugin.name,
        };
      }
    )
  );

/**
 * Every Function of a project: the registry's entries, then the Plugin-contributed ones. The
 * registry is never mutated. A registry key equal to a Plugin Function key is a config error,
 * unless the registry already holds that Plugin Function (an earlier result of this function).
 */
export const projectFunctionEntries = (
  functions: FunctionRegistry | FunctionRegistryInput | object,
  config: { readonly plugins?: readonly VokePlugin[] }
): [string, AnyFunctionDefinition][] => {
  const entries = functionRegistryEntries(functions);
  const pluginEntries = pluginFunctionEntries(config.plugins ?? []);

  if (pluginEntries.length === 0) {
    return entries;
  }

  const projectKeys = new Map(entries);
  const issues: VokeIssue[] = [];

  for (const { definition, key, name, plugin } of pluginEntries) {
    const existing = projectKeys.get(key);

    if (existing === definition) {
      continue;
    }

    if (existing !== undefined) {
      issues.push({
        message: `expected a Function key that Function "${name}" of Plugin "${plugin}" does not use; received ${JSON.stringify(key)}. Rename the Function in the project entrypoint`,
        path: `functions.${key}`,
      });
      continue;
    }

    entries.push([key, definition]);
  }

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return entries;
};
