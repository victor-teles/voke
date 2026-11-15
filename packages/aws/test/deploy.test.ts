import { expect, test } from "bun:test";

import {
  createFunctions,
  createVokeModel,
  defineConfig,
  http,
  route,
  VokeDeployError,
} from "voke";

import {
  bootstrapStackName,
  deployAwsStack,
  removeAwsStack,
} from "../src/deploy";
import type {
  ChangeSetChange,
  ChangeSetInput,
  DeployAwsClients,
  StackDescription,
  StackEvent,
} from "../src/deploy-clients";
import { credentialsMessage } from "../src/deploy-clients";
import { aws } from "../src/index";

interface FakeChangeSet extends ChangeSetInput {
  executed: boolean;
}

interface Scenario {
  /** Stacks whose next change set reports "no changes". */
  noChanges?: Set<string>;
  /** Stacks whose execution fails on a resource. */
  failOn?: Map<string, { logicalId: string; reason: string }>;
  /** Stacks whose deletion fails on a resource. */
  deleteFailsOn?: Map<string, { logicalId: string; reason: string }>;
  credentialFailure?: boolean;
  /** Stacks whose change set plans these changes instead of adding the HTTP Function. */
  changes?: Map<string, ChangeSetChange[]>;
}

const outputsFor = (stack: string): Record<string, string> =>
  stack === bootstrapStackName
    ? { ArtifactBucketName: "voke-artifacts" }
    : {
        ApiUrl: "https://abc123.execute-api.us-east-1.amazonaws.com",
        HttpFunctionName: `${stack}-http`,
      };

const createFakeClients = (scenario: Scenario = {}) => {
  const stacks = new Map<string, StackDescription>();
  const events = new Map<string, StackEvent[]>();
  const changeSets = new Map<string, FakeChangeSet>();
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let eventCounter = 0;

  const pushEvent = (
    stack: string,
    logicalId: string,
    resourceType: string,
    status: string,
    reason?: string
  ) => {
    eventCounter += 1;
    const list = events.get(stack) ?? [];
    list.unshift({
      id: `e${eventCounter}`,
      logicalId,
      reason,
      resourceType,
      status,
      timestamp: eventCounter,
    });
    events.set(stack, list);
  };

  const guard = () => {
    if (scenario.credentialFailure === true) {
      const error = new Error("Could not load credentials: secret-token-value");
      error.name = "CredentialsProviderError";
      throw new VokeDeployError(credentialsMessage, { cause: error });
    }
  };

  const clients: DeployAwsClients = {
    createChangeSet: async (input) => {
      guard();
      calls.push(`createChangeSet:${input.stackName}:${input.type}`);
      const id = `${input.stackName}/${input.changeSetName}`;
      changeSets.set(id, { ...input, executed: false });

      if (input.type === "CREATE" && !stacks.has(input.stackName)) {
        stacks.set(input.stackName, {
          outputs: {},
          status: "REVIEW_IN_PROGRESS",
        });
      }

      return await Promise.resolve({ id });
    },
    deleteChangeSet: async (id) => {
      calls.push(`deleteChangeSet:${id.split("/")[0]}`);
      changeSets.delete(id);
      await Promise.resolve();
    },
    deleteStack: async (name) => {
      calls.push(`deleteStack:${name}`);
      const failure = scenario.deleteFailsOn?.get(name);

      if (failure === undefined) {
        pushEvent(name, name, "AWS::CloudFormation::Stack", "DELETE_COMPLETE");
        stacks.delete(name);
      } else {
        pushEvent(
          name,
          failure.logicalId,
          "AWS::S3::Bucket",
          "DELETE_FAILED",
          failure.reason
        );
        pushEvent(name, name, "AWS::CloudFormation::Stack", "DELETE_FAILED");
        stacks.set(name, { outputs: {}, status: "DELETE_FAILED" });
      }

      await Promise.resolve();
    },
    describeChangeSet: async (id) => {
      const changeSet = changeSets.get(id);

      if (changeSet === undefined) {
        throw new Error(`unknown change set ${id}`);
      }

      if (scenario.noChanges?.has(changeSet.stackName) === true) {
        return await Promise.resolve({
          changes: [],
          status: "FAILED",
          statusReason:
            "The submitted information didn't contain changes. Submit different information to create a change set.",
        });
      }

      return await Promise.resolve({
        changes: scenario.changes?.get(changeSet.stackName) ?? [
          {
            action: "Add",
            logicalId: "Function",
            resourceType: "AWS::Lambda::Function",
          },
        ],
        status: "CREATE_COMPLETE",
      });
    },
    describeStack: async (name) => {
      guard();

      return await Promise.resolve(stacks.get(name));
    },
    describeStackEvents: async (name) =>
      await Promise.resolve([...(events.get(name) ?? [])]),
    executeChangeSet: async (id) => {
      const changeSet = changeSets.get(id);

      if (changeSet === undefined) {
        throw new Error(`unknown change set ${id}`);
      }

      calls.push(`executeChangeSet:${changeSet.stackName}`);
      const stack = changeSet.stackName;
      const failure = scenario.failOn?.get(stack);
      const verb = changeSet.type === "CREATE" ? "CREATE" : "UPDATE";

      if (failure === undefined) {
        pushEvent(
          stack,
          "Function",
          "AWS::Lambda::Function",
          `${verb}_COMPLETE`
        );
        pushEvent(
          stack,
          stack,
          "AWS::CloudFormation::Stack",
          `${verb}_COMPLETE`
        );
        stacks.set(stack, {
          outputs: outputsFor(stack),
          status: `${verb}_COMPLETE`,
        });
      } else {
        pushEvent(
          stack,
          failure.logicalId,
          "AWS::Lambda::Function",
          `${verb}_FAILED`,
          failure.reason
        );
        pushEvent(
          stack,
          stack,
          "AWS::CloudFormation::Stack",
          "ROLLBACK_COMPLETE"
        );
        stacks.set(stack, { outputs: {}, status: "ROLLBACK_COMPLETE" });
      }

      await Promise.resolve();
    },
    objectExists: async (bucket, key) =>
      await Promise.resolve(objects.has(`${bucket}/${key}`)),
    objectUrl: (bucket, key) =>
      `https://${bucket}.s3.us-east-1.amazonaws.com/${key}`,
    putObject: async (bucket, key, body) => {
      calls.push(`putObject:${key.endsWith(".zip") ? "zip" : "template"}`);
      objects.set(`${bucket}/${key}`, body);
      await Promise.resolve();
    },
  };

  return { calls, changeSets, clients, events, objects, stacks };
};

const project = () => {
  const config = defineConfig({
    name: "shop",
    provider: aws(),
    region: "us-east-1",
  });
  const functions = createFunctions({
    http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
  });

  return { config, model: createVokeModel({ ...config, functions }) };
};

const files: Record<string, string> = {
  "dist/cloudformation.json": "{}",
  "dist/index.js": "export const http = () => {};\n",
  "dist/package.json": '{"type":"module"}\n',
  "dist/voke-manifest.json":
    '{"functions":{"http":{"file":"dist/index.js","handler":"index.http"}}}\n',
};

const deploy = async (
  fake: ReturnType<typeof createFakeClients>,
  overrides: { dryRun?: boolean; artifactFiles?: string[] } = {}
) => {
  const lines: string[] = [];
  const { config, model } = project();
  const result = await deployAwsStack(
    {
      artifactDirectory: "dist",
      artifactFiles: overrides.artifactFiles ?? [
        "index.js",
        "package.json",
        "voke-manifest.json",
      ],
      config,
      dryRun: overrides.dryRun ?? false,
      model,
      output: (line) => {
        lines.push(line);
      },
      stage: "dev",
    },
    {
      clients: fake.clients,
      readFile: async (path) =>
        await Promise.resolve(new TextEncoder().encode(files[path] ?? "")),
      sleep: async () => {
        await Promise.resolve();
      },
    }
  );

  return { lines, result };
};

const templateOf = (fake: ReturnType<typeof createFakeClients>) => {
  const entry = [...fake.objects.entries()].find(([key]) =>
    key.endsWith(".json")
  );

  return JSON.parse(new TextDecoder().decode(entry?.[1])) as {
    Resources: Record<
      string,
      { Properties: Record<string, unknown>; Type: string }
    >;
  };
};

test("first deploy bootstraps the artifact bucket, uploads once, creates the stack and returns outputs", async () => {
  const fake = createFakeClients();
  const { lines, result } = await deploy(fake);

  expect(fake.calls).toEqual([
    `createChangeSet:${bootstrapStackName}:CREATE`,
    `executeChangeSet:${bootstrapStackName}`,
    "putObject:zip",
    "putObject:template",
    "createChangeSet:shop-dev:CREATE",
    "executeChangeSet:shop-dev",
  ]);
  expect(result).toEqual({
    id: "shop-dev",
    outputs: {
      ApiUrl: "https://abc123.execute-api.us-east-1.amazonaws.com",
      HttpFunctionName: "shop-dev-http",
    },
    region: "us-east-1",
    status: "deployed",
  });
  expect(
    lines.some(
      (line) =>
        line.includes("CREATE_COMPLETE") &&
        line.includes("AWS::Lambda::Function")
    )
  ).toBe(true);

  const template = templateOf(fake);
  const lambda = template.Resources.Function;

  expect(lambda?.Properties.Code).toMatchObject({ S3Bucket: "voke-artifacts" });
  expect(JSON.stringify(template)).not.toContain("ZipFile");
  expect(template.Resources.Stage?.Properties.StageName).toBe("$default");
});

test("a second deploy of the same build uploads nothing and reports no changes", async () => {
  const scenario: Scenario = {};
  const fake = createFakeClients(scenario);
  await deploy(fake);
  fake.calls.length = 0;
  // CloudFormation reports an identical template as "no changes".
  scenario.noChanges = new Set(["shop-dev"]);

  const { lines, result } = await deploy(fake);

  expect(fake.calls.filter((call) => call.startsWith("putObject"))).toEqual([]);
  expect(fake.calls).not.toContain("executeChangeSet:shop-dev");
  expect(result.status).toBe("unchanged");
  expect(result.outputs.ApiUrl).toBe(
    "https://abc123.execute-api.us-east-1.amazonaws.com"
  );
  expect(lines).toContain("No changes");
});

test("a stack left in ROLLBACK_COMPLETE is deleted and created again", async () => {
  const fake = createFakeClients();
  fake.stacks.set(bootstrapStackName, {
    outputs: { ArtifactBucketName: "voke-artifacts" },
    status: "CREATE_COMPLETE",
  });
  fake.stacks.set("shop-dev", { outputs: {}, status: "ROLLBACK_COMPLETE" });

  const { result } = await deploy(fake);

  expect(fake.calls).toContain("deleteStack:shop-dev");
  expect(fake.calls).toContain("createChangeSet:shop-dev:CREATE");
  expect(result.status).toBe("deployed");
});

test("a deployment already in progress is refused without executing anything", async () => {
  const fake = createFakeClients();
  fake.stacks.set(bootstrapStackName, {
    outputs: { ArtifactBucketName: "voke-artifacts" },
    status: "CREATE_COMPLETE",
  });
  fake.stacks.set("shop-dev", { outputs: {}, status: "UPDATE_IN_PROGRESS" });

  await expect(deploy(fake)).rejects.toThrow(
    "A deployment is already in progress for shop-dev (UPDATE_IN_PROGRESS)"
  );
  expect(fake.calls.some((call) => call.startsWith("executeChangeSet"))).toBe(
    false
  );
});

test("a failed execution reports the first failed resource and its reason", async () => {
  const fake = createFakeClients({
    failOn: new Map([
      [
        "shop-dev",
        {
          logicalId: "Function",
          reason: "Unzipped size must be smaller than 262144000 bytes",
        },
      ],
    ]),
  });

  await expect(deploy(fake)).rejects.toThrow(
    "Deploying shop-dev failed: Function (AWS::Lambda::Function): Unzipped size must be smaller than 262144000 bytes"
  );
});

test("a dry run prints the planned changes and never executes the change set", async () => {
  const fake = createFakeClients();
  fake.stacks.set(bootstrapStackName, {
    outputs: { ArtifactBucketName: "voke-artifacts" },
    status: "CREATE_COMPLETE",
  });

  const { lines, result } = await deploy(fake, { dryRun: true });

  expect(result.status).toBe("dry-run");
  expect(fake.calls.some((call) => call.startsWith("executeChangeSet"))).toBe(
    false
  );
  expect(fake.calls).toContain("deleteChangeSet:shop-dev");
  // The CREATE change set's empty stack is removed too.
  expect(fake.calls).toContain("deleteStack:shop-dev");
  expect(
    lines.some((line) => line.includes("Add") && line.includes("Function"))
  ).toBe(true);
});

test("credential failures become guidance without echoing credential material", async () => {
  const fake = createFakeClients({ credentialFailure: true });
  const failure = await deploy(fake).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(VokeDeployError);
  expect((failure as Error).message).toBe(credentialsMessage);
  expect((failure as Error).message).not.toContain("secret-token-value");
});

test("cloudformation.json and zip files are never packaged", async () => {
  const fake = createFakeClients();
  await deploy(fake, {
    artifactFiles: [
      "index.js",
      "package.json",
      "cloudformation.json",
      "old.zip",
    ],
  });
  const zip = [...fake.objects.entries()].find(([key]) =>
    key.endsWith(".zip")
  )?.[1];
  const text = new TextDecoder("latin1").decode(zip);

  expect(text).toContain("index.js");
  expect(text).not.toContain("cloudformation.json");
  expect(text).not.toContain("old.zip");
});

test("remove reports a missing stack as absent", async () => {
  const fake = createFakeClients();
  const { config } = project();

  await expect(
    removeAwsStack(
      { config, output: () => {}, stage: "dev" },
      { clients: fake.clients, sleep: async () => await Promise.resolve() }
    )
  ).resolves.toEqual({ status: "absent" });
});

test("remove deletes the stack and reports resources that failed to delete", async () => {
  const { config } = project();
  const removed = createFakeClients();
  removed.stacks.set("shop-dev", { outputs: {}, status: "UPDATE_COMPLETE" });

  await expect(
    removeAwsStack(
      { config, output: () => {}, stage: "dev" },
      { clients: removed.clients, sleep: async () => await Promise.resolve() }
    )
  ).resolves.toEqual({ status: "removed" });

  const blocked = createFakeClients({
    deleteFailsOn: new Map([
      [
        "shop-dev",
        {
          logicalId: "UploadsBucket",
          reason: "The bucket you tried to delete is not empty",
        },
      ],
    ]),
  });
  blocked.stacks.set("shop-dev", { outputs: {}, status: "UPDATE_COMPLETE" });

  await expect(
    removeAwsStack(
      { config, output: () => {}, stage: "dev" },
      { clients: blocked.clients, sleep: async () => await Promise.resolve() }
    )
  ).rejects.toThrow(
    "Could not delete stack shop-dev: UploadsBucket (AWS::S3::Bucket) failed: The bucket you tried to delete is not empty"
  );
});

const replacingFunction = (): Map<string, ChangeSetChange[]> =>
  new Map([
    [
      "shop-dev",
      [
        {
          action: "Modify",
          logicalId: "FulfilOrderFunction",
          replacement: "True",
          resourceType: "AWS::Lambda::Function",
        },
        {
          action: "Modify",
          logicalId: "FulfilOrderFunctionRole",
          replacement: "False",
          resourceType: "AWS::IAM::Role",
        },
      ],
    ],
  ]);

test("a change set that replaces a named Lambda fails before executing and is deleted", async () => {
  const fake = createFakeClients({ changes: replacingFunction() });
  fake.stacks.set("shop-dev", { outputs: {}, status: "UPDATE_COMPLETE" });

  const failure = await deploy(fake).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(VokeDeployError);
  expect((failure as Error).message).toContain(
    "Function FulfilOrderFunction must be replaced"
  );
  expect((failure as Error).message).toContain("durable");
  expect(fake.calls).toContain("deleteChangeSet:shop-dev");
  expect(fake.calls).not.toContain("executeChangeSet:shop-dev");
});

test("a dry run warns about a named Lambda replacement instead of failing", async () => {
  const fake = createFakeClients({ changes: replacingFunction() });
  fake.stacks.set("shop-dev", { outputs: {}, status: "UPDATE_COMPLETE" });

  const { lines, result } = await deploy(fake, { dryRun: true });

  expect(result.status).toBe("dry-run");
  expect(
    lines.some(
      (line) =>
        line.startsWith("Warning:") &&
        line.includes("Function FulfilOrderFunction must be replaced")
    )
  ).toBe(true);
  expect(fake.calls).not.toContain("executeChangeSet:shop-dev");
});
