import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import packageJson from "../package.json";
import { loadVokeConfig } from "./config";
import type { VokeConfig } from "./config";
import { createInternalModel } from "./model";
import { loadProject } from "./project";
import type { DiagnosticResult } from "./provider";

export interface DoctorOptions {
  /** Config file. Default: voke.config.ts. */
  configPath?: string;
  /** Default: Bun.version. */
  bunVersion?: string;
  /** Default: the current directory. */
  cwd?: string;
  output: (message: string) => void;
}

export interface DoctorReport {
  failed: boolean;
  results: DiagnosticResult[];
}

const ok = (check: string, detail: string): DiagnosticResult => ({
  check,
  detail,
  status: "ok",
});
const warn = (check: string, detail: string): DiagnosticResult => ({
  check,
  detail,
  status: "warn",
});
const fail = (check: string, detail: string): DiagnosticResult => ({
  check,
  detail,
  status: "fail",
});

const plural = (value: number, noun: string): string =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const bunCheck = (version: string): DiagnosticResult => {
  const range = (packageJson as { engines?: { bun?: string } }).engines?.bun;

  if (range === undefined || Bun.semver.satisfies(version, range)) {
    return ok("Bun", version);
  }

  return fail("Bun", `${version} does not satisfy ${range}; run bun upgrade`);
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const loadConfigCheck = async (
  path: string
): Promise<{ config?: VokeConfig; result: DiagnosticResult }> => {
  if (!(await exists(path))) {
    return {
      result: fail(
        "Config",
        `${path} not found; create a project with voke create <name>, or pass --config`
      ),
    };
  }

  try {
    return {
      config: await loadVokeConfig({ path }),
      result: ok("Config", path),
    };
  } catch (error) {
    return { result: fail("Config", messageOf(error)) };
  }
};

const projectChecks = async (
  config: VokeConfig,
  cwd: string
): Promise<{ functions?: unknown; results: DiagnosticResult[] }> => {
  const entrypoint = resolve(cwd, config.entrypoint);

  if (!(await exists(entrypoint))) {
    return {
      results: [
        fail(
          "Entrypoint",
          `${config.entrypoint} not found; set entrypoint in voke.config.ts`
        ),
      ],
    };
  }

  try {
    const project = await loadProject({ config, cwd });
    const model = createInternalModel({
      ...config,
      functions: project.functions,
    });
    const functions = Object.keys(model.functions).length;
    const routes = Object.values(model.apis).reduce(
      (count, api) => count + api.routes.length,
      0
    );

    return {
      functions: project.functions,
      results: [
        ok("Entrypoint", config.entrypoint),
        ok(
          "Project",
          `${plural(functions, "Function")}, ${plural(routes, "route")}`
        ),
      ],
    };
  } catch (error) {
    return {
      results: [
        ok("Entrypoint", config.entrypoint),
        fail("Project", messageOf(error)),
      ],
    };
  }
};

const providerChecks = async (
  config: VokeConfig,
  functions: unknown
): Promise<DiagnosticResult[]> => {
  const { provider } = config;

  if (provider === undefined) {
    return [
      warn(
        "Provider",
        'not configured; add provider: aws() from "@voke/aws" to voke.config.ts'
      ),
    ];
  }

  const rows = [ok("Provider", provider.name)];

  if (provider.diagnostics === undefined) {
    return rows;
  }

  try {
    const model = createInternalModel({
      ...config,
      functions: functions as never,
    });

    return [...rows, ...(await provider.diagnostics.run({ config, model }))];
  } catch (error) {
    return [...rows, fail(`${provider.name} diagnostics`, messageOf(error))];
  }
};

const formatRows = (results: readonly DiagnosticResult[]): string[] => {
  const width = Math.max(...results.map((result) => result.check.length));

  return results.map((result) =>
    `${result.status.padEnd(4)}  ${result.check.padEnd(width)}  ${result.detail}`.trimEnd()
  );
};

/** `voke doctor`: core checks, then the Provider's diagnostics. Prints one row per check. */
export const runDoctor = async (
  options: DoctorOptions
): Promise<DoctorReport> => {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? "voke.config.ts";
  const results: DiagnosticResult[] = [
    bunCheck(options.bunVersion ?? Bun.version),
  ];
  const loaded = await loadConfigCheck(
    isAbsolute(configPath) ? configPath : resolve(cwd, configPath)
  );

  results.push(loaded.result);

  if (loaded.config !== undefined) {
    const project = await projectChecks(loaded.config, cwd);

    results.push(
      ...project.results,
      ...(await providerChecks(loaded.config, project.functions))
    );
  }

  for (const line of formatRows(results)) {
    options.output(line);
  }

  return {
    failed: results.some((result) => result.status === "fail"),
    results,
  };
};
