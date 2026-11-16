import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVokeModel, defineConfig } from "voke";
import type { ProviderCommandRunOptions } from "voke";

import { dynamodbTable, s3Bucket, sqsQueue } from "../src/cloudformation";
import {
  awsEmulator,
  createLocalWorkflow,
  localOutputsPath,
} from "../src/local";

// Needs Docker and downloads the AWS Emulator package (a 1.2 GB image) on first run.
const enabled = process.env.VOKE_E2E_EMULATOR === "1";
const port = 9399;
const minute = 60_000;

const run = async (
  command: string[],
  options: ProviderCommandRunOptions = {}
): Promise<void> => {
  const env: Record<string, string | undefined> = { ...process.env };

  for (const name of options.unsetEnv ?? []) {
    Reflect.deleteProperty(env, name);
  }

  const child = Bun.spawn(command, {
    env: { ...env, ...options.env },
    stderr: "inherit",
    stdout: "inherit",
  });

  if ((await child.exited) !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
};

// Runs in a child started with the Local AWS Provider environment, as `voke dev` does, so
// NODE_EXTRA_CA_CERTS is present at process start. S3 is the data-plane check because @vokejs/aws
// already depends on its client; the table and queue are checked through the stack outputs.
const clientScript = (awsIndex: string) => `
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createAwsClientConfig } from "${awsIndex}";

const bucket = process.env.VOKE_RESOURCE_UPLOADS_BUCKET_NAME;
const s3 = new S3Client({ ...createAwsClientConfig(), forcePathStyle: true });

await s3.send(new PutObjectCommand({ Body: "hello", Bucket: bucket, Key: "greeting.txt" }));
const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "greeting.txt" }));

console.log(JSON.stringify({ body: await object.Body?.transformToString() }));
`;

test(
  "provisions resources on the AWS Emulator and reaches them through createAwsClientConfig",
  async () => {
    if (!enabled) {
      return;
    }

    const project = await realpath(
      await mkdtemp(join(tmpdir(), "voke-aws-emulator-e2e-"))
    );
    const provider = awsEmulator({ port });
    const workflow = createLocalWorkflow(provider, { cwd: () => project });
    const config = defineConfig({
      name: "emulator-e2e",
      resources: {
        eventsQueue: sqsQueue(),
        uploadsBucket: s3Bucket(),
        usersTable: dynamodbTable({ partitionKey: "id" }),
      },
      stage: "local",
    });
    const context = {
      config,
      model: createVokeModel(config),
      options: { template: join(project, "cloudformation.json") },
      run,
    };

    try {
      await workflow.start(context);
      await workflow.bootstrap(context);

      const outputs = await Bun.file(join(project, localOutputsPath)).json();

      expect(outputs.bindings.VOKE_RESOURCE_USERS_TABLE_NAME).toStartWith(
        "emulator-e2e-local-UsersTable"
      );
      expect(outputs.bindings.VOKE_RESOURCE_EVENTS_QUEUE_URL).toContain(
        "emulator-e2e-local-EventsQueue"
      );

      const environment = await provider.environment({
        directory: join(project, ".voke", "local", "aws-emulator"),
        region: config.region,
      });
      const script = join(project, "client.ts");

      await Bun.write(
        script,
        clientScript(join(import.meta.dir, "../src/index.ts"))
      );

      const env: Record<string, string | undefined> = { ...process.env };

      for (const name of provider.unsetEnvironment ?? []) {
        Reflect.deleteProperty(env, name);
      }

      const child = Bun.spawn(["bun", script], {
        cwd: import.meta.dir,
        env: { ...env, ...environment, ...outputs.bindings },
        stderr: "inherit",
        stdout: "pipe",
      });
      const stdout = await new Response(child.stdout).text();

      expect(await child.exited).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ body: "hello" });
    } finally {
      await workflow.stop(context).catch(() => {});
      expect(await Bun.file(join(project, localOutputsPath)).exists()).toBe(
        false
      );
      await rm(project, { force: true, recursive: true });
    }
  },
  5 * minute
);
