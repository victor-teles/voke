import packageJson from "../package.json";
import { VokeError } from "./errors";

export class CliUsageError extends VokeError {
  constructor(message: string) {
    super(message, { code: "CLI_USAGE_ERROR" });
    this.name = "CliUsageError";
  }
}

/** The one message every Provider-dependent command gives when no Provider is configured. */
export const missingProviderMessage = (name: string): string =>
  `No provider configured. Add a provider to voke.config.ts, for example:

  import { aws } from "@voke/aws";
  export default defineConfig({ name: ${JSON.stringify(name)}, provider: aws() });`;

export interface CliFlagSpec {
  description: string;
  /** Takes no value: `--yes` means true. */
  boolean?: boolean;
}

export interface CliCommandSpec {
  usage: string;
  description: string;
  flags: Readonly<Record<string, CliFlagSpec>>;
}

export interface ParsedFlags {
  values: Record<string, string>;
  positional: string[];
}

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
    usage: "voke create <name> [directory]",
  },
  deploy: {
    description: "Build and deploy a stage through the Provider.",
    flags: {
      ...projectFlags,
      "dry-run": {
        boolean: true,
        description: "Preview the changes without applying them",
      },
    },
    usage:
      "voke deploy [--stage dev] [--region us-east-1] [--config voke.config.ts] [--dry-run]",
  },
  dev: {
    description: "Run the API locally with hot reload.",
    flags: {
      ...projectFlags,
      endpoint: { description: "Local cloud endpoint for resource bindings" },
      hostname: { description: "Hostname. Default: localhost" },
      port: { description: "Port. Default: 3000" },
    },
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
    usage: "voke local <start|stop|reset|bootstrap>",
  },
  migrate: {
    description:
      "Generate a Voke skeleton from a Serverless Framework service.",
    flags: {
      out: { description: "Output directory. Default: ./voke-migration" },
    },
    usage: "voke migrate serverless [serverless.yml] [--out ./voke-migration]",
  },
  remote: {
    description: "Generate Remote Function Registry modules from remotes.",
    flags: projectFlags,
    usage: "voke remote generate [name]",
  },
  remove: {
    description: "Delete a deployed stage through the Provider.",
    flags: {
      ...projectFlags,
      yes: { boolean: true, description: "Skip the confirmation prompt" },
    },
    usage:
      "voke remove [--stage dev] [--region us-east-1] [--config voke.config.ts] [--yes]",
  },
  synth: {
    description: "Write the Provider's deployment template.",
    flags: {
      ...projectFlags,
      out: { description: "Output file. Default: cloudFormation.out" },
    },
    usage:
      "voke synth [entrypoint] [out] [--config voke.config.ts] [--name api] [--stage local] [--region us-east-1]",
  },
};

const helpFlags = new Set(["--help", "-h"]);

export const isHelpRequest = (args: readonly string[]): boolean =>
  args.some((arg) => helpFlags.has(arg));

export const formatHelp = (): string => {
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
    "",
    "Run voke <command> --help for its flags. voke --version prints the version.",
  ].join("\n");
};

export const formatCommandHelp = (name: string): string => {
  const spec = commandSpecs[name];

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

export const cliUsageMessage = (message: string, command: string): string => {
  const spec = commandSpecs[command];

  return spec === undefined
    ? `Invalid CLI usage: ${message}\nRun \`voke --help\` to see available commands.`
    : `Invalid CLI usage: ${message}\nUsage: ${spec.usage}`;
};

const isBooleanFlag = (command: string, flag: string): boolean =>
  commandSpecs[command]?.flags[flag]?.boolean === true;

export const parseFlags = (command: string, args: string[]): ParsedFlags => {
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/[=](.*)/su, 2);
    const key = rawKey ?? "";

    if (key === "") {
      throw new CliUsageError(`Invalid flag: ${arg}`);
    }

    if (inlineValue !== undefined) {
      values[key] = inlineValue;
      continue;
    }

    if (isBooleanFlag(command, key)) {
      values[key] = "true";
      continue;
    }

    const value = args[index + 1];
    const isKnown = commandSpecs[command]?.flags[key] !== undefined;

    if (value === undefined || value.startsWith("--")) {
      if (!isKnown) {
        // Left for assertKnownFlags, which names the flag and suggests a close one.
        values[key] = "true";
        continue;
      }

      throw new CliUsageError(`Missing value for --${key}`);
    }

    values[key] = value;
    index += 1;
  }

  return { positional, values };
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

/** Throws for a flag the command does not read; `extra` adds Provider-declared flags. */
export const assertKnownFlags = (
  command: string,
  flags: ParsedFlags,
  extra: readonly string[] = []
): void => {
  const known = [...Object.keys(commandSpecs[command]?.flags ?? {}), ...extra];

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
