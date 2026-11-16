import { expect, test } from "bun:test";

import { aws } from "../src/index";
import { aws as runtimeAws } from "../src/provider-runtime";

test("the run-time aws() has the invoke, name and runtime capabilities only", () => {
  expect(Object.keys(runtimeAws()).toSorted()).toEqual([
    "invoke",
    "name",
    "runtime",
  ]);
});

test("the run-time aws() accepts the options without reading them", () => {
  const options = {
    lambda: { runtime: "python3.12" },
  } as unknown as Parameters<typeof runtimeAws>[0];

  expect(() => runtimeAws(options)).not.toThrow();
  expect(() => aws(options)).toThrow();
});

test("the full aws() extends the run-time capabilities with the deploy-time ones", () => {
  const full = aws();
  const runtime = runtimeAws();

  expect(full.name).toBe(runtime.name);
  expect(full.runtime?.routeAuth).toBe(runtime.runtime?.routeAuth);
  expect(Object.keys(full).toSorted()).toEqual([
    "build",
    "deploy",
    "diagnostics",
    "invoke",
    "local",
    "name",
    "runtime",
    "synthesis",
    "validate",
  ]);
});
