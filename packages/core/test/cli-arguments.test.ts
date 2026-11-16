import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { commandSpecs } from "../src/cli-spec";
import { tempPath } from "./support/temp";

const directory = tempPath(`voke-cli-arguments-${crypto.randomUUID()}`);
const configPath = join(directory, "voke.config.ts");
const noProviderConfigPath = join(directory, "no-provider.config.ts");
const outdir = join(directory, "dist");
const entrypoint = join(directory, "src", "index.ts");

interface RecordingGlobal {
  vokeArgumentCalls?: string[];
}

const calls: string[] = [];
(globalThis as RecordingGlobal).vokeArgumentCalls = calls;

const remoteContract = (name: string): string =>
  `http://${name}.remote.test/_voke/contract`;

// The fixture project is written once, the first time a test needs it.
let fixture: Promise<void> | undefined;

const writeFixture = async (): Promise<void> => {
  await mkdir(outdir, { recursive: true });
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(outdir, "index.js"), "export {};\n");
  await writeFile(
    entrypoint,
    `import { createFunctions, http, route } from "${import.meta.dir}/../src/index.ts";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );
  await writeFile(
    configPath,
    `const calls = globalThis.vokeArgumentCalls;
const outdir = ${JSON.stringify(outdir)};
const step = (name) => async (context) => {
  calls.push("local:" + name + ":" + context.config.stage);
};

export default {
  entrypoint: ${JSON.stringify(entrypoint)},
  name: "routed",
  stage: "staging",
  remotes: {
    orders: {
      out: ${JSON.stringify(join(directory, "remotes", "orders.ts"))},
      targets: { staging: { contract: ${JSON.stringify(remoteContract("orders"))}, origin: "http://orders.remote.test" } },
    },
    users: {
      out: ${JSON.stringify(join(directory, "remotes", "users.ts"))},
      targets: { staging: { contract: ${JSON.stringify(remoteContract("users"))}, origin: "http://users.remote.test" } },
    },
  },
  provider: {
    name: "recording",
    build: {
      plan: () => ({
        command: ["bun", "build"],
        entrypoints: [],
        files: {},
        manifest: { functions: {} },
        outdir,
        outputs: { entry: { file: outdir + "/index.js" } },
        sources: {},
      }),
    },
    deploy: {
      deploy: async (input) => {
        calls.push("deploy:" + input.stage);
        return { id: "routed-" + input.stage, outputs: {}, status: "dry-run" };
      },
      remove: async (input) => {
        calls.push("remove:" + input.stage);
        return { status: "removed" };
      },
    },
    local: {
      workflow: {
        bootstrap: step("bootstrap"),
        reset: step("reset"),
        start: step("start"),
        stop: step("stop"),
      },
    },
  },
};
`
  );
  await writeFile(
    noProviderConfigPath,
    `export default {
  entrypoint: ${JSON.stringify(join(directory, "missing", "index.ts"))},
  name: "bare",
};
`
  );
};

const ensureFixture = (): Promise<void> => {
  fixture ??= writeFixture();
  return fixture;
};

afterEach(() => {
  calls.length = 0;
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

const ignoreOutput = (): undefined => undefined;

/** Runs the CLI against the fixture project with `--config`. */
const run = async (
  args: string[],
  options: { run?: NonNullable<Parameters<typeof runCli>[1]>["run"] } = {}
): Promise<void> => {
  await ensureFixture();
  await runCli([...args, "--config", configPath], {
    interactive: false,
    output: ignoreOutput,
    run: options.run ?? (() => {}),
  });
};

const expectUsageError = async (
  args: string[],
  message: string
): Promise<void> => {
  await expect(run(args)).rejects.toThrow(`Invalid CLI usage: ${message}`);
  expect(calls).toEqual([]);
};

test("a stage given as an argument is rejected with the --stage spelling", async () => {
  await expect(run(["deploy", "prod", "--dry-run"])).rejects.toThrow(
    `Invalid CLI usage: Unexpected argument "prod" for "deploy". Did you mean --stage prod?\nUsage: ${commandSpecs.deploy?.usage}`
  );
  expect(calls).toEqual([]);
  await expectUsageError(
    ["remove", "prod", "--yes"],
    'Unexpected argument "prod" for "remove". Did you mean --stage prod?'
  );
});

test("short flags are rejected and name the long flag", async () => {
  await expectUsageError(
    ["deploy", "-s", "prod"],
    "Short flags are not supported: -s. Did you mean --stage?"
  );
  await expectUsageError(
    ["deploy", "-stage", "prod"],
    "Short flags are not supported: -stage. Did you mean --stage?"
  );
  await expectUsageError(
    ["remove", "-y"],
    "Short flags are not supported: -y. Did you mean --yes?"
  );
  await expect(run(["deploy", "-x"])).rejects.toThrow(
    "Invalid CLI usage: Short flags are not supported: -x.\nUsage: voke deploy"
  );
  expect(calls).toEqual([]);
});

test("a flag with an empty value is a missing value", async () => {
  await expectUsageError(
    ["deploy", "--stage=", "--dry-run"],
    "Missing value for --stage"
  );
  await expectUsageError(
    ["deploy", "--stage", "", "--dry-run"],
    "Missing value for --stage"
  );
  await expectUsageError(["remove", "--yes="], "Missing value for --yes");
});

test("an argument a command does not take is rejected", async () => {
  await expectUsageError(
    ["doctor", "extra"],
    'Unexpected argument "extra" for "doctor".'
  );
  await expectUsageError(
    ["synth", "a", "b", "c"],
    'Unexpected argument "c" for "synth".'
  );
  await expectUsageError(
    ["local", "start", "extra"],
    'Unexpected argument "extra" for "local".'
  );
  await expectUsageError(
    ["remote", "generate", "users", "extra"],
    'Unexpected argument "extra" for "remote".'
  );
  // migrate reads no config, so it runs without --config.
  await expect(
    runCli(["migrate", "serverless", "a.yml", "out"], { output: ignoreOutput })
  ).rejects.toThrow(
    'Invalid CLI usage: Unexpected argument "out" for "migrate". Did you mean --out out?'
  );
});

test("an entrypoint given as an argument and as --entrypoint is rejected", async () => {
  const message =
    'Got both the argument "./a.ts" and --entrypoint. Pass the entrypoint once.';

  await expectUsageError(
    ["synth", "./a.ts", "--entrypoint", "./b.ts"],
    message
  );
  await expectUsageError(
    ["build", "./a.ts", "--entrypoint", "./b.ts"],
    message
  );
});

test("voke local reads its subcommand after core flags", async () => {
  await run(["local", "--stage", "dev", "start"]);

  expect(calls).toEqual(["local:start:dev"]);
});

test("voke local rejects a missing or unknown subcommand", async () => {
  await expectUsageError(
    ["local"],
    "Missing argument: <start|stop|reset|bootstrap>"
  );
  await expectUsageError(
    ["local", "strat"],
    'Unknown argument "strat" for "local". Expected one of: start, stop, reset, bootstrap.'
  );
});

const withRecordedFetch = async (
  body: () => Promise<void>
): Promise<string[]> => {
  const fetched: string[] = [];
  const previous = globalThis.fetch;

  globalThis.fetch = Object.assign(
    (input: string | URL | Request): Promise<Response> => {
      fetched.push(String(input));
      return Promise.resolve(
        Response.json({
          data: { fingerprint: "f", functions: {}, project: "p", version: 1 },
        })
      );
    },
    { preconnect: previous.preconnect }
  );

  try {
    await body();
  } finally {
    globalThis.fetch = previous;
  }

  return fetched;
};

test("voke remote generate reads its action after core flags and generates the named remote", async () => {
  const fetched = await withRecordedFetch(() =>
    run(["remote", "--stage", "staging", "generate", "users"])
  );

  expect(fetched).toEqual([remoteContract("users")]);
});

test("voke remote generate with no name generates every remote", async () => {
  const fetched = await withRecordedFetch(() => run(["remote", "generate"]));

  expect(fetched).toEqual([remoteContract("orders"), remoteContract("users")]);
});

test("voke create needs a project name", async () => {
  await expect(runCli(["create"], { output: ignoreOutput })).rejects.toThrow(
    "Invalid CLI usage: Missing argument: <name>\nUsage: voke create <name> [directory]"
  );
});

test("voke dev accepts only a port number from 1 to 65535", async () => {
  for (const port of ["abc", "0", "70000", "1e3", "-1"]) {
    await expectUsageError(
      ["dev", "--port", port],
      `Invalid value for --port: "${port}". Expected a port number from 1 to 65535.`
    );
  }

  await expectUsageError(["dev", "--port="], "Missing value for --port");
});

test("voke dev passes a valid port to the dev server origin", async () => {
  let environment: Record<string, string> | undefined;

  await run(["dev", "--port", "4000"], {
    run: (_command, options) => {
      environment = options?.env;
    },
  });

  expect(environment?.VOKE_DEV_ORIGIN).toBe("http://localhost:4000");
});

test("voke build without a Provider gives the shared message before importing the project", async () => {
  await ensureFixture();

  await expect(
    runCli(["build", "--config", noProviderConfigPath], {
      output: ignoreOutput,
      run: () => {},
    })
  ).rejects.toThrow(
    "No provider configured. Add a provider to voke.config.ts, for example:"
  );
});

const usageLabel = (positional: {
  choices?: readonly string[];
  name: string;
  required?: boolean;
}): string => {
  if (positional.choices !== undefined) {
    return positional.choices.join("|");
  }

  return positional.required === true
    ? `<${positional.name}>`
    : `[${positional.name}]`;
};

test("every declared positional appears in its command's usage", () => {
  for (const [name, spec] of Object.entries(commandSpecs)) {
    for (const positional of spec.positionals ?? []) {
      expect(`${name}: ${spec.usage}`).toContain(usageLabel(positional));
    }

    if (spec.strayArgumentFlag !== undefined) {
      expect(Object.keys(spec.flags)).toContain(spec.strayArgumentFlag);
    }
  }
});
