import { expect, test } from "bun:test";

import packageJson from "../package.json";
import * as voke from "../src/index";

const importPackage = async (
  specifier: string
): Promise<Record<string, unknown>> => await import(specifier);

test("keeps root voke runtime values provider-neutral", () => {
  expect(Object.keys(voke).toSorted()).toEqual([
    "InvokeError",
    "VokeConfigError",
    "activateFunctionRegistry",
    "createFunctions",
    "createHandlerNameFromEntrypoint",
    "createVokeModel",
    "defineConfig",
    "fn",
    "http",
    "invokeRegistryFunction",
    "loadVokeConfig",
    "route",
    "toEnvKey",
    "voke",
  ]);
});

test("removes specialized helper subpaths from core package exports", () => {
  expect(Object.keys(packageJson.exports).toSorted()).toEqual(["."]);
});

test("publishes schema helper from @voke/schema", async () => {
  const schemaHelpers = await importPackage("@voke/schema");

  expect(Object.keys(schemaHelpers).toSorted()).toEqual(["schema"]);
  expect("schema" in voke).toBe(false);
});

test("publishes HTTP helpers from @voke/http", async () => {
  const httpHelpers = await importPackage("@voke/http");

  expect(Object.keys(httpHelpers).toSorted()).toEqual([
    "created",
    "error",
    "json",
    "jsonError",
    "noContent",
    "ok",
    "response",
  ]);
  expect("response" in voke).toBe(false);
});

test("publishes build helpers from @voke/build", async () => {
  const build = await importPackage("@voke/build");

  expect(Object.keys(build).toSorted()).toEqual(["createBuildPlan"]);
  expect("createBuildPlan" in voke).toBe(false);
});
