import { createHandlerNameFromEntrypoint, defineConfig } from "voke";
import type {
  AnyFunctionDefinition,
  VokeConfig,
  VokeConfigInput,
} from "voke";

export interface BuildPlan {
  command: string[];
  entrypoints: string[];
  outdir: string;
  outputs: Record<string, BuildPlanOutput>;
  target: "bun";
}

export interface BuildPlanOutput {
  file: string;
  handler: string;
}

export interface BuildPlanOverrides {
  entrypoints?: string[];
  outdir?: string;
}

const toOutputFileName = (entrypoint: string): string => {
  const fileName = entrypoint.split("/").at(-1) ?? "index.ts";

  return fileName.replace(/\.[^.]+$/u, ".js");
};

export const createBuildPlan = (
  input: VokeConfig | VokeConfigInput,
  overrides: BuildPlanOverrides = {}
): BuildPlan => {
  const config = defineConfig(input);
  const entrypoints = overrides.entrypoints ?? config.build.entrypoints;
  const outdir = overrides.outdir ?? config.build.outdir;
  const functionHandlers: Record<string, string> = {};

  for (const [key, definition] of Object.entries(config.functions)) {
    if (key === "invoke") {
      continue;
    }

    const functionDefinition = definition as AnyFunctionDefinition;
    const entrypoint = functionDefinition.synthesis?.entrypoint;

    if (entrypoint !== undefined) {
      functionHandlers[entrypoint] =
        functionDefinition.synthesis?.handler ??
        createHandlerNameFromEntrypoint(entrypoint);
    }
  }

  const outputs = Object.fromEntries(
    entrypoints.map((entrypoint) => [
      entrypoint,
      {
        file: `${outdir}/${toOutputFileName(entrypoint)}`,
        handler:
          entrypoint === config.entrypoint
            ? config.cloudFormation.handler
            : (functionHandlers[entrypoint] ??
              createHandlerNameFromEntrypoint(entrypoint)),
      },
    ])
  );

  return {
    command: [
      "bun",
      "build",
      ...entrypoints,
      "--outdir",
      outdir,
      "--target",
      config.build.target,
    ],
    entrypoints,
    outdir,
    outputs,
    target: config.build.target,
  };
};
