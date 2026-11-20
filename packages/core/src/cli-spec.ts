import packageJson from "../package.json";
import { VokeError } from "./errors";
import type {
  CliFlagSpec,
  CliPositionalSpec,
  PluginCommand,
  VokePlugin,
} from "./plugin";

export class CliUsageError extends VokeError {
  constructor(message: string) {
    super(message, { code: "CLI_USAGE_ERROR" });
    this.name = "CliUsageError";
  }
}

/** The one message every Provider-dependent command gives when no Provider is configured. */
export const missingProviderMessage = (name: string): string =>
  `No provider configured. Add a provider to voke.config.ts, for example:

  import { aws } from "@vokejs/aws";
  export default defineConfig({ name: ${JSON.stringify(name)}, provider: aws() });`;

export type { CliFlagSpec, CliPositionalSpec } from "./plugin";

export interface CliCommandSpec {
  usage: string;
  description: string;
  flags: Readonly<Record<string, CliFlagSpec>>;
  /** The arguments the command takes, in order. Omitted: none. */
  positionals?: readonly CliPositionalSpec[];
  /** The flag an extra argument most likely meant, named in the usage error. */
  strayArgumentFlag?: string;
}

export interface ParsedFlags {
  values: Record<string, string>;
  positional: string[];
}

export const localSubcommands = [
  "start",
  "stop",
  "reset",
  "bootstrap",
] as const;

const configFlag: CliFlagSpec = {
  description: "Config file. Default: voke.config.ts",
};
const nameFlag: CliFlagSpec = {
  description: "Project name when there is no config file",
};
const stageFlag: CliFlagSpec = {
  description: "Stage. Default: VOKE_STAGE, then the config",
};
const regionFlag: CliFlagSpec = { description: "Region. Default: the config" };
const entrypointFlag: CliFlagSpec = {
  description: "Project entrypoint. Default: ./src/index.ts",
};

// Flags every config-reading command accepts.
const projectFlags = {
  config: configFlag,
  entrypoint: entrypointFlag,
  name: nameFlag,
  region: regionFlag,
  stage: stageFlag,
} as const;

/**
 * Every command, its usage, and the flags it reads. Help, usage errors and flag validation all
 * come from this one table, so they cannot drift apart. Add new commands here.
 */
export const commandSpecs: Readonly<Record<string, CliCommandSpec>> = {
  build: {
    description: "Bundle the project's Functions through the Provider.",
    flags: {
      ...projectFlags,
      outdir: { description: "Output directory. Default: ./dist" },
    },
    positionals: [
      { flag: "entrypoint", name: "entrypoint" },
      { flag: "outdir", name: "outdir" },
    ],
    usage: "voke build [entrypoint] [outdir]",
  },
  create: {
    description: "Create a new API project and install its dependencies.",
    flags: {
      force: {
        boolean: true,
        description:
          "Write into a non-empty directory, overwriting the starter files",
      },
      "no-install": { boolean: true, description: "Skip bun install" },
    },
    positionals: [{ name: "name", required: true }, { name: "directory" }],
    usage: "voke create <name> [directory]",
  },
  deploy: {
    description: "Build and deploy a stage through the Provider.",
    flags: {
      ...projectFlags,
      "accept-data-loss": {
        boolean: true,
        description:
          "Apply changes that remove or replace a resource that holds data",
      },
      "dry-run": {
        boolean: true,
        description: "Preview the changes without applying them",
      },
    },
    strayArgumentFlag: "stage",
    usage:
      "voke deploy [--stage dev] [--region us-east-1] [--config voke.config.ts] [--dry-run] [--accept-data-loss]",
  },
  dev: {
    description: "Run the API locally with hot reload.",
    flags: {
      ...projectFlags,
      endpoint: { description: "Local cloud endpoint for resource bindings" },
      hostname: { description: "Hostname. Default: localhost" },
      port: { description: "Port. Default: 3000" },
    },
    positionals: [{ flag: "entrypoint", name: "entrypoint" }],
    usage: "voke dev [entrypoint] [--hostname localhost] [--port 3000]",
  },
  doctor: {
    description: "Check the toolchain, the project and the Provider.",
    flags: { config: configFlag },
    usage: "voke doctor [--config voke.config.ts]",
  },
  local: {
    description:
      "Run the Provider's local environment. The Provider may accept more flags.",
    flags: projectFlags,
    positionals: [
      { choices: localSubcommands, name: "subcommand", required: true },
    ],
    usage: "voke local <start|stop|reset|bootstrap>",
  },
  migrate: {
    description:
      "Generate a Voke skeleton from a Serverless Framework service.",
    flags: {
      out: { description: "Output directory. Default: ./voke-migration" },
    },
    positionals: [
      { choices: ["serverless"], name: "source", required: true },
      { name: "serverless.yml" },
    ],
    strayArgumentFlag: "out",
    usage: "voke migrate serverless [serverless.yml] [--out ./voke-migration]",
  },
  remote: {
    description: "Generate Remote Function Registry modules from remotes.",
    flags: projectFlags,
    positionals: [
      { choices: ["generate"], name: "action", required: true },
      { name: "name" },
    ],
    usage: "voke remote generate [name]",
  },
  remove: {
    description: "Delete a deployed stage through the Provider.",
    flags: {
      ...projectFlags,
      yes: { boolean: true, description: "Skip the confirmation prompt" },
    },
    strayArgumentFlag: "stage",
    usage:
      "voke remove [--stage dev] [--region us-east-1] [--config voke.config.ts] [--yes]",
  },
  synth: {
    description: "Write the Provider's deployment template.",
    flags: {
      ...projectFlags,
      out: { description: "Output file. Default: cloudFormation.out" },
    },
    positionals: [
      { flag: "entrypoint", name: "entrypoint" },
      { flag: "out", name: "out" },
    ],
    usage:
      "voke synth [entrypoint] [out] [--config voke.config.ts] [--name api] [--stage local] [--region us-east-1]",
  },
};

const helpFlags = new Set(["--help", "-h"]);

export const isHelpRequest = (args: readonly string[]): boolean =>
  args.some((arg) => helpFlags.has(arg));

type CommandSpecs = Readonly<Record<string, CliCommandSpec>>;

/** `voke <plugin> <command>` lines for every command of every Plugin that declares `cli`. */
const pluginCommandLines = (plugins: readonly VokePlugin[]): string[] => {
  const commands = plugins.flatMap((plugin) =>
    Object.entries(plugin.cli?.commands ?? {}).map(
      ([command, spec]) =>
        [`${plugin.name} ${command}`, spec.description] as const
    )
  );

  if (commands.length === 0) {
    return [];
  }

  const width = Math.max(...commands.map(([name]) => name.length));

  return [
    "",
    "Plugin commands:",
    ...commands.map(
      ([name, description]) => `  voke ${name.padEnd(width)}  ${description}`
    ),
  ];
};

export const formatHelp = (plugins: readonly VokePlugin[] = []): string => {
  const names = Object.keys(commandSpecs).toSorted();
  const width = Math.max(...names.map((name) => name.length));

  return [
    `Voke v${packageJson.version}`,
    "",
    "Usage: voke <command> [options]",
    "",
    "Commands:",
    ...names.map(
      (name) =>
        `  voke ${name.padEnd(width)}  ${commandSpecs[name]?.description ?? ""}`
    ),
    ...pluginCommandLines(plugins),
    "",
    "Run voke <command> --help for its flags. voke --version prints the version.",
  ].join("\n");
};

/** `voke <plugin>` help: the Plugin's description and its commands. */
export const formatPluginHelp = (plugin: VokePlugin): string => {
  const commands = Object.entries(plugin.cli?.commands ?? {});
  const width = Math.max(0, ...commands.map(([name]) => name.length));

  return [
    `Usage: voke ${plugin.name} <command> [options]`,
    "",
    plugin.cli?.description ?? "",
    "",
    "Commands:",
    ...commands.map(
      ([name, command]) =>
        `  voke ${plugin.name} ${name.padEnd(width)}  ${command.description}`
    ),
    "",
    `Run voke ${plugin.name} <command> --help for its flags.`,
  ].join("\n");
};

/** The spec of `voke <plugin> <command>`, keyed `<plugin> <command>`; it always reads `--config`. */
export const pluginCommandSpecs = (
  plugin: VokePlugin,
  command: string,
  spec: PluginCommand
): CommandSpecs => ({
  [`${plugin.name} ${command}`]: {
    description: spec.description,
    flags: { ...spec.flags, config: configFlag },
    ...(spec.positionals === undefined
      ? {}
      : { positionals: spec.positionals }),
    usage: spec.usage,
  },
});

export const formatCommandHelp = (
  name: string,
  specs: CommandSpecs = commandSpecs
): string => {
  const spec = specs[name];

  if (spec === undefined) {
    throw new CliUsageError(`Unknown command: ${name}`);
  }

  const flags = Object.entries(spec.flags).map(([flag, flagSpec]) => [
    `--${flag}${flagSpec.boolean === true ? "" : " <value>"}`,
    flagSpec.description,
  ]);
  const width = Math.max(...flags.map(([flag]) => flag?.length ?? 0));

  return [
    `Usage: ${spec.usage}`,
    "",
    spec.description,
    ...(flags.length === 0
      ? []
      : [
          "",
          "Flags:",
          ...flags.map(([flag, description]) =>
            `  ${(flag ?? "").padEnd(width)}  ${description}`.trimEnd()
          ),
        ]),
  ].join("\n");
};

export const cliUsageMessage = (
  message: string,
  command: string,
  specs: CommandSpecs = commandSpecs
): string => {
  const spec = specs[command];

  return spec === undefined
    ? `Invalid CLI usage: ${message}\nRun \`voke --help\` to see available commands.`
    : `Invalid CLI usage: ${message}\nUsage: ${spec.usage}`;
};

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (const [leftIndex, leftChar] of [...left].entries()) {
    const current = [leftIndex + 1];

    for (const [rightIndex, rightChar] of [...right].entries()) {
      current.push(
        Math.min(
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex + 1] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + (leftChar === rightChar ? 0 : 1)
        )
      );
    }

    previous = current;
  }

  return previous[right.length] ?? 0;
};

const maxSuggestionDistance = 2;

const closestFlag = (
  flag: string,
  known: readonly string[]
): string | undefined => {
  let best: { distance: number; name: string } | undefined;

  for (const name of known) {
    const distance = editDistance(flag, name);

    if (
      distance <= maxSuggestionDistance &&
      (best === undefined || distance < best.distance)
    ) {
      best = { distance, name };
    }
  }

  return best?.name;
};

/** `-s` is not a flag: names the long flag it most likely meant. -h and -v are handled earlier. */
const shortFlagError = (
  arg: string,
  known: readonly string[]
): CliUsageError => {
  const name = arg.slice(1);
  const suggestion =
    (name.length > 1 ? closestFlag(name, known) : undefined) ??
    known.find((flag) => flag.startsWith(name.charAt(0)));

  return new CliUsageError(
    `Short flags are not supported: ${arg}.${suggestion === undefined ? "" : ` Did you mean --${suggestion}?`}`
  );
};

// `--stage=$UNSET` must not select a stage named "".
const nonEmptyValue = (key: string, value: string): string => {
  if (value === "") {
    throw new CliUsageError(`Missing value for --${key}`);
  }

  return value;
};

export const parseFlags = (
  command: string,
  args: string[],
  specs: CommandSpecs = commandSpecs
): ParsedFlags => {
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") {
        throw shortFlagError(arg, Object.keys(specs[command]?.flags ?? {}));
      }

      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/[=](.*)/su, 2);
    const key = rawKey ?? "";

    if (key === "") {
      throw new CliUsageError(`Invalid flag: ${arg}`);
    }

    if (inlineValue !== undefined) {
      values[key] = nonEmptyValue(key, inlineValue);
      continue;
    }

    if (specs[command]?.flags[key]?.boolean === true) {
      values[key] = "true";
      continue;
    }

    const value = args[index + 1];
    const isKnown = specs[command]?.flags[key] !== undefined;

    if (value === undefined || value.startsWith("--")) {
      if (!isKnown) {
        // Left for assertKnownFlags, which names the flag and suggests a close one.
        values[key] = "true";
        continue;
      }

      throw new CliUsageError(`Missing value for --${key}`);
    }

    values[key] = nonEmptyValue(key, value);
    index += 1;
  }

  return { positional, values };
};

/** Throws for a flag the command does not read; `extra` adds Provider-declared flags. */
export const assertKnownFlags = (
  command: string,
  flags: ParsedFlags,
  extra: readonly string[] = [],
  specs: CommandSpecs = commandSpecs
): void => {
  const known = [...Object.keys(specs[command]?.flags ?? {}), ...extra];

  for (const flag of Object.keys(flags.values)) {
    if (known.includes(flag)) {
      continue;
    }

    const suggestion = closestFlag(flag, known);

    throw new CliUsageError(
      `Unknown flag --${flag} for "${command}".${suggestion === undefined ? "" : ` Did you mean --${suggestion}?`}`
    );
  }
};

const positionalLabel = (positional: CliPositionalSpec): string =>
  positional.choices === undefined
    ? `<${positional.name}>`
    : `<${positional.choices.join("|")}>`;

/** Throws for a missing, unknown, duplicated or extra argument of the command. */
export const assertPositionals = (
  command: string,
  flags: ParsedFlags,
  specs: CommandSpecs = commandSpecs
): void => {
  const spec = specs[command];
  const declared = spec?.positionals ?? [];

  for (const [index, positional] of declared.entries()) {
    const value = flags.positional[index];

    if (value === undefined) {
      if (positional.required === true) {
        throw new CliUsageError(
          `Missing argument: ${positionalLabel(positional)}`
        );
      }

      continue;
    }

    if (
      positional.choices !== undefined &&
      !positional.choices.includes(value)
    ) {
      throw new CliUsageError(
        `Unknown argument "${value}" for "${command}". Expected one of: ${positional.choices.join(", ")}.`
      );
    }

    if (
      positional.flag !== undefined &&
      flags.values[positional.flag] !== undefined
    ) {
      throw new CliUsageError(
        `Got both the argument "${value}" and --${positional.flag}. Pass the ${positional.name} once.`
      );
    }
  }

  const extra = flags.positional[declared.length];

  if (extra === undefined) {
    return;
  }

  const strayFlag = spec?.strayArgumentFlag;
  const hint =
    strayFlag === undefined || flags.values[strayFlag] !== undefined
      ? ""
      : ` Did you mean --${strayFlag} ${extra}?`;

  throw new CliUsageError(
    `Unexpected argument "${extra}" for "${command}".${hint}`
  );
};
