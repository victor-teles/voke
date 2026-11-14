import { expect, test } from "bun:test";

import { runCli } from "../src/cli";
import { runDoctor } from "../src/doctor";
import { tempPath } from "./support/temp";

const coreIndex = `${import.meta.dir}/../src/index.ts`;

const writeProject = async (provider: string): Promise<string> => {
  const directory = tempPath(`voke-doctor-${crypto.randomUUID()}`);

  await Bun.write(
    `${directory}/src/index.ts`,
    `import { createFunctions, fn, http, route } from "${coreIndex}";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" }), route.get("/ready", { handler: () => "ok" })] }),
  worker: fn({ handler: () => ({ ok: true }) }),
});
`
  );
  await Bun.write(
    `${directory}/voke.config.ts`,
    `export default {
  entrypoint: "./src/index.ts",
  name: "doctor-api",
  provider: ${provider},
};
`
  );

  return directory;
};

const doctor = async (directory: string, bunVersion = "1.4.4") => {
  const lines: string[] = [];
  const report = await runDoctor({
    bunVersion,
    cwd: directory,
    output: (line) => {
      lines.push(line);
    },
  });

  return { lines, report };
};

test("prints one ok row per check, then the Provider's diagnostics", async () => {
  const directory = await writeProject(`{
    name: "fake",
    diagnostics: {
      run: async ({ config, model }) => [
        { check: "Fake account", detail: config.name + " " + Object.keys(model.functions).length, status: "ok" },
      ],
    },
  }`);
  const { lines, report } = await doctor(directory);

  expect(report.failed).toBe(false);
  expect(lines).toEqual([
    "ok    Bun           1.4.4",
    `ok    Config        ${directory}/voke.config.ts`,
    "ok    Entrypoint    ./src/index.ts",
    "ok    Project       2 Functions, 2 routes",
    "ok    Provider      fake",
    "ok    Fake account  doctor-api 2",
  ]);
});

test("fails when the config is missing", async () => {
  const directory = tempPath(`voke-doctor-empty-${crypto.randomUUID()}`);
  const { lines, report } = await doctor(directory);

  expect(report.failed).toBe(true);
  expect(lines[1]).toBe(
    `fail  Config  ${directory}/voke.config.ts not found; create a project with voke create <name>, or pass --config`
  );
});

test("warns without a Provider and runs only the core checks without diagnostics", async () => {
  const withoutProvider = await doctor(await writeProject("undefined"));
  const withoutDiagnostics = await doctor(
    await writeProject('{ name: "plain" }')
  );

  expect(withoutProvider.report.failed).toBe(false);
  expect(withoutProvider.lines.at(-1)).toBe(
    'warn  Provider    not configured; add provider: aws() from "@voke/aws" to voke.config.ts'
  );
  expect(withoutDiagnostics.lines.at(-1)).toBe("ok    Provider    plain");
  expect(withoutDiagnostics.lines).toHaveLength(5);
});

test("a fail row or a throwing Provider fails the report", async () => {
  const failing = await doctor(
    await writeProject(`{
    name: "fake",
    diagnostics: { run: async () => [{ check: "Credentials", detail: "expired", status: "fail" }] },
  }`)
  );
  const throwing = await doctor(
    await writeProject(`{
    name: "fake",
    diagnostics: { run: async () => { throw new Error("boom"); } },
  }`)
  );

  expect(failing.report.failed).toBe(true);
  expect(failing.lines.at(-1)).toBe("fail  Credentials  expired");
  expect(throwing.report.failed).toBe(true);
  expect(throwing.lines.at(-1)).toBe("fail  fake diagnostics  boom");
});

test("flags a Bun version below the supported range", async () => {
  const { lines, report } = await doctor(
    await writeProject("undefined"),
    "1.3.0"
  );

  expect(report.failed).toBe(true);
  expect(lines[0]).toBe(
    "fail  Bun         1.3.0 does not satisfy >=1.4.4; run bun upgrade"
  );
});

test("voke doctor exits non-zero when a row fails", async () => {
  const directory = tempPath(`voke-doctor-cli-${crypto.randomUUID()}`);

  await expect(
    runCli(["doctor", "--config", `${directory}/voke.config.ts`], {
      output: () => {},
    })
  ).rejects.toThrow("voke doctor found problems; see the fail rows above.");
});
