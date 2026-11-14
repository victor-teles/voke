import { expect, test } from "bun:test";

import { createVokeModel, defineConfig, VokeDeployError } from "voke";

import { credentialsMessage } from "../src/deploy-clients";
import type { StackDescription } from "../src/deploy-clients";
import { createAwsDiagnostics } from "../src/diagnostics";
import type { AwsDiagnosticsDependencies } from "../src/diagnostics";
import { aws } from "../src/index";
import { floci } from "../src/local";

const config = defineConfig({ name: "doctor-api", region: "sa-east-1" });
const input = { config, model: createVokeModel(config) };

const fakeDeps = (
  // null stands for "no bootstrap stack yet".
  describeStack: () => Promise<StackDescription | null>,
  which: AwsDiagnosticsDependencies["which"] = () => "/usr/local/bin/docker"
): AwsDiagnosticsDependencies => ({
  describeStack: async () => (await describeStack()) ?? undefined,
  which,
});

test("reports the account and region when credentials resolve, and the local tool", async () => {
  const rows = await createAwsDiagnostics(
    floci(),
    fakeDeps(() =>
      Promise.resolve({
        id: "arn:aws:cloudformation:sa-east-1:123456789012:stack/voke-bootstrap/abc",
        outputs: {},
        status: "CREATE_COMPLETE",
      })
    )
  ).run(input);

  expect(rows).toEqual([
    {
      check: "AWS credentials",
      detail: "account 123456789012, region sa-east-1",
      status: "ok",
    },
    { check: "docker", detail: "/usr/local/bin/docker", status: "ok" },
  ]);
});

test("counts a missing bootstrap stack as ok", async () => {
  const [credentials] = await createAwsDiagnostics(
    floci(),
    fakeDeps(() => Promise.resolve(null))
  ).run(input);

  expect(credentials).toEqual({
    check: "AWS credentials",
    detail: "region sa-east-1 (account shown after the first deploy)",
    status: "ok",
  });
});

test("fails on credential errors without echoing credential material", async () => {
  const secret = "AKIAEXAMPLESECRET";
  const [credentials] = await createAwsDiagnostics(
    floci(),
    fakeDeps(() =>
      Promise.reject(
        new VokeDeployError(credentialsMessage, {
          cause: new Error(`token ${secret} expired`),
        })
      )
    )
  ).run(input);

  expect(credentials).toEqual({
    check: "AWS credentials",
    detail: credentialsMessage,
    status: "fail",
  });
  expect(JSON.stringify(credentials)).not.toContain(secret);
});

test("reports other AWS errors as a failed reachability check", async () => {
  const [credentials] = await createAwsDiagnostics(
    floci(),
    fakeDeps(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")))
  ).run(input);

  expect(credentials).toEqual({
    check: "AWS credentials",
    detail:
      "could not reach CloudFormation in sa-east-1: getaddrinfo ENOTFOUND",
    status: "fail",
  });
});

test("warns when the local container tool is missing, since only voke local needs it", async () => {
  const rows = await createAwsDiagnostics(
    floci(),
    fakeDeps(
      () => Promise.resolve(null),
      () => null
    )
  ).run(input);

  expect(rows.at(-1)).toEqual({
    check: "docker",
    detail: "not found; install it to use voke local",
    status: "warn",
  });
});

test("aws() attaches the diagnostics capability", () => {
  expect(typeof aws().diagnostics?.run).toBe("function");
});

test("finds the local tool on PATH with Node APIs", async () => {
  const rows = await createAwsDiagnostics(floci(), {
    describeStack: () => Promise.reject(new Error("offline")),
    which: (command) => (command === "docker" ? "/opt/bin/docker" : null),
  }).run(input);

  expect(rows.at(-1)?.detail).toBe("/opt/bin/docker");
});

test("fails the credentials check instead of hanging when AWS does not answer", async () => {
  const [credentials] = await createAwsDiagnostics(floci(), {
    // A call that never settles, like an unreachable AWS endpoint.
    describeStack: () => Promise.race<undefined>([]),
    timeoutMs: 10,
    which: () => null,
  }).run(input);

  expect(credentials).toEqual({
    check: "AWS credentials",
    detail:
      "AWS did not answer within 0.01s in sa-east-1; check your network and credentials (AWS_PROFILE, SSO login)",
    status: "fail",
  });
});
