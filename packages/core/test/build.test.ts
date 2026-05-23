import { expect, test } from "bun:test";

import { runCli } from "../src/cli";
import {
  createBuildPlan,
  defineConfig,
  defineFunction,
  defineFunctions,
  Voke,
} from "../src/index";
import type { StandardSchemaV1 } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

test("normalizes build inputs and Lambda handler output from config", () => {
  const sendWelcomeEmail = defineFunction({
    handler: (payload) => ({
      queued: true,
      to: payload.email,
    }),
    input: schema<{ email: string }>(),
    name: "sendWelcomeEmail",
    output: schema<{ queued: boolean; to: string }>(),
    synthesis: {
      entrypoint: "./src/functions/send-welcome-email.ts",
      handler: "email.handler",
      runtime: "nodejs24.x",
    },
  });
  const config = defineConfig({
    build: {
      outdir: "./build",
    },
    entrypoint: "./src/api.ts",
    functions: {
      sendWelcomeEmail,
    },
    name: "orders-api",
  });

  expect(config.build).toEqual({
    entrypoints: ["./src/api.ts", "./src/functions/send-welcome-email.ts"],
    outdir: "./build",
    target: "bun",
  });
  expect(config.cloudFormation.handler).toBe("api.handler");
  expect(createBuildPlan(config)).toEqual({
    command: [
      "bun",
      "build",
      "./src/api.ts",
      "./src/functions/send-welcome-email.ts",
      "--outdir",
      "./build",
      "--target",
      "bun",
    ],
    entrypoints: ["./src/api.ts", "./src/functions/send-welcome-email.ts"],
    outdir: "./build",
    outputs: {
      "./src/api.ts": {
        file: "./build/api.js",
        handler: "api.handler",
      },
      "./src/functions/send-welcome-email.ts": {
        file: "./build/send-welcome-email.js",
        handler: "email.handler",
      },
    },
    target: "bun",
  });
});

test("build CLI uses config by default and lets flags override one-off runs", async () => {
  const directory = `/private/tmp/voke-build-cli-${crypto.randomUUID()}`;
  const configPath = `${directory}/voke.config.ts`;
  const commands: string[][] = [];

  await Bun.$`mkdir -p ${directory}`;
  await Bun.write(
    configPath,
    `import { defineConfig } from "${import.meta.dir}/../src/index";

export default defineConfig({
  name: "build-api",
  entrypoint: "./src/api.ts",
  build: {
    outdir: "./configured-dist",
  },
});
`
  );

  await runCli(["build", "--config", configPath], {
    run: (command) => {
      commands.push(command);
    },
  });
  await runCli(
    [
      "build",
      "--config",
      configPath,
      "--entrypoint",
      "./src/worker.ts",
      "--outdir",
      "./tmp-build",
    ],
    {
      run: (command) => {
        commands.push(command);
      },
    }
  );

  expect(commands).toEqual([
    [
      "bun",
      "build",
      "./src/api.ts",
      "--outdir",
      "./configured-dist",
      "--target",
      "bun",
    ],
    [
      "bun",
      "build",
      "./src/worker.ts",
      "--outdir",
      "./tmp-build",
      "--target",
      "bun",
    ],
  ]);
});

test("includes route-backed and invokable Function entrypoints in build plans", () => {
  const app = new Voke();
  const config = defineConfig({
    entrypoint: "./src/index.ts",
    functions: defineFunctions({
      checkout: defineFunction({
        handler: (payload) => ({ id: payload.cartId }),
        input: schema<{ cartId: string }>(),
        output: schema<{ id: string }>(),
        synthesis: {
          entrypoint: "./src/functions/checkout.ts",
        },
      }),
      users: defineFunction({
        routes: [
          app.get("/users", {
            handler: () => [],
          }),
        ],
        synthesis: {
          entrypoint: "./src/functions/users.ts",
          handler: "users.handler",
        },
      }),
    }),
    name: "build-functions",
  });

  expect(createBuildPlan(config)).toMatchObject({
    command: [
      "bun",
      "build",
      "./src/index.ts",
      "./src/functions/checkout.ts",
      "./src/functions/users.ts",
      "--outdir",
      "./dist",
      "--target",
      "bun",
    ],
    entrypoints: [
      "./src/index.ts",
      "./src/functions/checkout.ts",
      "./src/functions/users.ts",
    ],
    outputs: {
      "./src/functions/checkout.ts": {
        file: "./dist/checkout.js",
        handler: "checkout.handler",
      },
      "./src/functions/users.ts": {
        file: "./dist/users.js",
        handler: "users.handler",
      },
      "./src/index.ts": {
        file: "./dist/index.js",
        handler: "index.handler",
      },
    },
  });
});
