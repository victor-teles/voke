import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { VokeDeployError } from "voke";
import type {
  ProviderDeployInput,
  ProviderDeployResult,
  ProviderRemoveInput,
  VokeModel,
} from "voke";

import { synthesizeCloudFormationFromModel } from "./cloudformation-synthesis";
import type {
  ChangeSetDescription,
  DeployAwsClients,
  StackDescription,
  StackEvent,
} from "./deploy-clients";
import { createAwsClientConfig } from "./resources";
import { createZip } from "./zip";

export interface DeployDependencies {
  clients: DeployAwsClients;
  now?: () => number;
  pollIntervalMs?: number;
  readFile?: (path: string) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
  /** Give up following a stack operation after this long. Defaults to one hour. */
  timeoutMs?: number;
}

/** The stack that owns the artifact bucket, one per account and region. */
export const bootstrapStackName = "voke-bootstrap";
const manifestFileName = "voke-manifest.json";
const excludedArtifactFile = /(^|\/)cloudformation\.json$|\.zip$/u;
const noChangesReason =
  /didn't contain changes|No updates are to be performed/u;

const bootstrapTemplate = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "Voke deployment artifacts",
  Outputs: {
    ArtifactBucketName: {
      Description: "Bucket that stores Voke deployment bundles and templates",
      Value: { Ref: "ArtifactBucket" },
    },
  },
  Resources: {
    ArtifactBucket: {
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
      Type: "AWS::S3::Bucket",
    },
  },
});

interface Runtime {
  clients: DeployAwsClients;
  now: () => number;
  output: (line: string) => void;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}

const runtimeFor = (
  deps: DeployDependencies,
  output: (line: string) => void
): Runtime => ({
  clients: deps.clients,
  now: deps.now ?? Date.now,
  output,
  pollIntervalMs: deps.pollIntervalMs ?? 2000,
  sleep:
    deps.sleep ??
    (async (ms) => {
      await delay(ms);
    }),
  timeoutMs: deps.timeoutMs ?? 60 * 60 * 1000,
});

const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const formatSize = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const isTerminalStackStatus = (status: string): boolean =>
  !status.endsWith("_IN_PROGRESS");

const isSuccessfulStackStatus = (status: string): boolean =>
  status === "CREATE_COMPLETE" ||
  status === "UPDATE_COMPLETE" ||
  status === "DELETE_COMPLETE" ||
  status === "IMPORT_COMPLETE";

// ---- following stack operations ------------------------------------------------------------

const firstFailure = (events: readonly StackEvent[]): StackEvent | undefined =>
  events.find(
    (event) =>
      event.status.endsWith("_FAILED") &&
      event.reason !== undefined &&
      !event.reason.includes("Resource creation cancelled")
  );

/**
 * Prints each new stack event until the stack reaches a terminal state and returns that state.
 * Events already present when following starts are skipped.
 */
const followStack = async (
  runtime: Runtime,
  stackName: string,
  seen: Set<string>
): Promise<{ events: StackEvent[]; status: string }> => {
  const started = runtime.now();
  const newEvents: StackEvent[] = [];

  for (;;) {
    await runtime.sleep(runtime.pollIntervalMs);
    const allEvents = await runtime.clients.describeStackEvents(stackName);
    const events = allEvents
      .filter((event) => !seen.has(event.id))
      .toReversed();

    for (const event of events) {
      seen.add(event.id);
      newEvents.push(event);
      runtime.output(
        `  ${event.status.padEnd(20)} ${event.resourceType.padEnd(34)} ${event.logicalId}`
      );

      const isStackEvent =
        event.logicalId === stackName &&
        event.resourceType === "AWS::CloudFormation::Stack";

      if (isStackEvent && isTerminalStackStatus(event.status)) {
        return { events: newEvents, status: event.status };
      }
    }

    // The stack status is the source of truth: a deleted stack cannot be described by name,
    // and the terminal stack event can arrive between two polls.
    const stack = await runtime.clients.describeStack(stackName);

    if (stack === undefined) {
      return { events: newEvents, status: "DELETE_COMPLETE" };
    }

    if (
      isTerminalStackStatus(stack.status) &&
      stack.status !== "REVIEW_IN_PROGRESS"
    ) {
      return { events: newEvents, status: stack.status };
    }

    if (runtime.now() - started > runtime.timeoutMs) {
      throw new VokeDeployError(
        `Timed out waiting for stack ${stackName}. Check its events in the CloudFormation console.`
      );
    }
  }
};

const eventIds = async (
  runtime: Runtime,
  stackName: string
): Promise<Set<string>> => {
  const events = await runtime.clients.describeStackEvents(stackName);

  return new Set(events.map((event) => event.id));
};

const deleteStackAndWait = async (
  runtime: Runtime,
  stackName: string
): Promise<void> => {
  const seen = await eventIds(runtime, stackName);

  await runtime.clients.deleteStack(stackName);
  const { events, status } = await followStack(runtime, stackName, seen);

  if (status !== "DELETE_COMPLETE") {
    const failure = firstFailure(events);

    throw new VokeDeployError(
      failure === undefined
        ? `Could not delete stack ${stackName} (${status}). Check its events in the CloudFormation console.`
        : `Could not delete stack ${stackName}: ${failure.logicalId} (${failure.resourceType}) failed: ${failure.reason}. Fix or empty that resource, then run voke remove again.`
    );
  }
};

// ---- change sets -----------------------------------------------------------------------------

const waitForChangeSet = async (
  runtime: Runtime,
  id: string
): Promise<ChangeSetDescription> => {
  const started = runtime.now();

  for (;;) {
    const description = await runtime.clients.describeChangeSet(id);

    if (
      description.status === "CREATE_COMPLETE" ||
      description.status === "FAILED"
    ) {
      return description;
    }

    if (runtime.now() - started > runtime.timeoutMs) {
      throw new VokeDeployError(`Timed out waiting for change set ${id}.`);
    }

    await runtime.sleep(runtime.pollIntervalMs);
  }
};

interface StackDeployment {
  dryRun: boolean;
  stackName: string;
  template: { body: string } | { url: string };
}

/** Plans and (unless dry-run) applies one stack through a change set. */
/**
 * Settles the stack's current state before a change set: a failed first create is deleted, a
 * stack mid-operation or stuck in UPDATE_ROLLBACK_FAILED is refused, and a stack left in
 * REVIEW_IN_PROGRESS by an earlier dry run (no resources yet) is created again.
 */
const prepareStack = async (
  runtime: Runtime,
  stackName: string
): Promise<{ existing?: StackDescription; type: "CREATE" | "UPDATE" }> => {
  const existing = await runtime.clients.describeStack(stackName);

  if (existing === undefined || existing.status === "REVIEW_IN_PROGRESS") {
    return { type: "CREATE" };
  }

  if (existing.status === "ROLLBACK_COMPLETE") {
    runtime.output(
      `Stack ${stackName} failed to create earlier (ROLLBACK_COMPLETE); deleting it before retrying`
    );
    await deleteStackAndWait(runtime, stackName);

    return { type: "CREATE" };
  }

  if (existing.status === "UPDATE_ROLLBACK_FAILED") {
    throw new VokeDeployError(
      `Stack ${stackName} is in UPDATE_ROLLBACK_FAILED. In the CloudFormation console choose "Continue update rollback" for it, then deploy again.`
    );
  }

  if (existing.status.endsWith("_IN_PROGRESS")) {
    throw new VokeDeployError(
      `A deployment is already in progress for ${stackName} (${existing.status}). Wait for it to finish, then deploy again.`
    );
  }

  return { existing, type: "UPDATE" };
};

/** Prints the planned changes and discards them; nothing is executed. */
const discardPreview = async (
  runtime: Runtime,
  stackName: string,
  changeSetId: string,
  description: ChangeSetDescription,
  type: "CREATE" | "UPDATE"
): Promise<void> => {
  for (const change of description.changes) {
    runtime.output(
      `  ${change.action.padEnd(8)} ${change.resourceType.padEnd(34)} ${change.logicalId}`
    );
  }

  await runtime.clients.deleteChangeSet(changeSetId);

  if (type === "CREATE") {
    // The CREATE change set made an empty REVIEW_IN_PROGRESS stack; leave nothing behind.
    await runtime.clients.deleteStack(stackName);
  }
};

const executeAndFollow = async (
  runtime: Runtime,
  stackName: string,
  changeSetId: string,
  hadStack: boolean
): Promise<Record<string, string>> => {
  const seen = hadStack
    ? await eventIds(runtime, stackName)
    : new Set<string>();

  await runtime.clients.executeChangeSet(changeSetId);
  const { events, status } = await followStack(runtime, stackName, seen);

  if (!isSuccessfulStackStatus(status)) {
    const failure = firstFailure(events);

    throw new VokeDeployError(
      failure === undefined
        ? `Deploying ${stackName} failed (${status}). Check its events in the CloudFormation console.`
        : `Deploying ${stackName} failed: ${failure.logicalId} (${failure.resourceType}): ${failure.reason}`
    );
  }

  const deployed = await runtime.clients.describeStack(stackName);

  return deployed?.outputs ?? {};
};

/** Plans and (unless dry-run) applies one stack through a change set. */
const deployStack = async (
  runtime: Runtime,
  deployment: StackDeployment
): Promise<Omit<ProviderDeployResult, "id" | "region">> => {
  const { stackName } = deployment;
  const { existing, type } = await prepareStack(runtime, stackName);
  const { id } = await runtime.clients.createChangeSet({
    capabilities: ["CAPABILITY_IAM"],
    changeSetName: `voke-${runtime.now()}`,
    stackName,
    type,
    ...("body" in deployment.template
      ? { templateBody: deployment.template.body }
      : { templateUrl: deployment.template.url }),
  });
  const description = await waitForChangeSet(runtime, id);
  const currentOutputs = existing?.outputs ?? {};

  if (description.status === "FAILED") {
    await runtime.clients.deleteChangeSet(id);

    if (noChangesReason.test(description.statusReason ?? "")) {
      return { outputs: currentOutputs, status: "unchanged" };
    }

    throw new VokeDeployError(
      `CloudFormation could not plan the changes for ${stackName}: ${description.statusReason ?? "unknown reason"}`
    );
  }

  if (deployment.dryRun) {
    await discardPreview(runtime, stackName, id, description, type);

    return { outputs: currentOutputs, status: "dry-run" };
  }

  const outputs = await executeAndFollow(
    runtime,
    stackName,
    id,
    existing !== undefined
  );

  return { outputs, status: "deployed" };
};

// ---- bootstrap and artifacts -----------------------------------------------------------------

const ensureArtifactBucket = async (runtime: Runtime): Promise<string> => {
  const existing = await runtime.clients.describeStack(bootstrapStackName);
  const existingBucket = existing?.outputs.ArtifactBucketName;

  if (
    existingBucket !== undefined &&
    isSuccessfulStackStatus(existing?.status ?? "")
  ) {
    return existingBucket;
  }

  runtime.output(
    `Creating the ${bootstrapStackName} stack for deployment artifacts`
  );
  const result = await deployStack(runtime, {
    dryRun: false,
    stackName: bootstrapStackName,
    template: { body: bootstrapTemplate },
  });
  const bucket = result.outputs.ArtifactBucketName;

  if (bucket === undefined) {
    throw new VokeDeployError(
      `The ${bootstrapStackName} stack has no ArtifactBucketName output. Delete the stack, then deploy again.`
    );
  }

  return bucket;
};

const uploadOnce = async (
  runtime: Runtime,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<boolean> => {
  if (await runtime.clients.objectExists(bucket, key)) {
    return false;
  }

  await runtime.clients.putObject(bucket, key, body, contentType);

  return true;
};

const readArtifact = async (
  input: ProviderDeployInput,
  read: (path: string) => Promise<Uint8Array>
) => {
  const files = input.artifactFiles.filter(
    (file) => !excludedArtifactFile.test(file)
  );

  return await Promise.all(
    files.map(async (path) => ({
      data: await read(join(input.artifactDirectory, path)),
      path,
    }))
  );
};

/**
 * Lambda handler strings come from the build manifest when present: when explicit per-Function
 * entrypoints widen the bundle root, the generated entry is not at the archive root.
 */
const withManifestHandlers = (
  model: VokeModel,
  entries: readonly { data: Uint8Array; path: string }[]
): VokeModel => {
  const manifest = entries.find((entry) => entry.path === manifestFileName);

  if (manifest === undefined) {
    return model;
  }

  const { functions = {} } = JSON.parse(
    new TextDecoder().decode(manifest.data)
  ) as {
    functions?: Record<string, { handler?: string }>;
  };

  return {
    ...model,
    functions: Object.fromEntries(
      Object.entries(model.functions).map(([key, definition]) => [
        key,
        {
          ...definition,
          handler: functions[key]?.handler ?? definition.handler,
        },
      ])
    ),
  };
};

// ---- capability entry points -----------------------------------------------------------------

export const deployAwsStack = async (
  input: ProviderDeployInput,
  deps: DeployDependencies
): Promise<ProviderDeployResult> => {
  const runtime = runtimeFor(deps, input.output);
  const stackName = `${input.config.name}-${input.stage}`;
  const region =
    input.region ?? input.config.region ?? createAwsClientConfig().region;
  const started = runtime.now();
  const entries = await readArtifact(
    input,
    deps.readFile ?? (async (path) => new Uint8Array(await readFile(path)))
  );
  const bundle = createZip(entries);
  const bundleHash = sha256Hex(bundle).slice(0, 16);

  runtime.output(
    `Packaged ${stackName} (${input.stage})  ${formatSize(bundle.byteLength)}`
  );

  const bucket = await ensureArtifactBucket(runtime);
  const bundleKey = `${input.config.name}/${input.stage}/${bundleHash}.zip`;
  const uploaded = await uploadOnce(
    runtime,
    bucket,
    bundleKey,
    bundle,
    "application/zip"
  );

  runtime.output(uploaded ? "Uploaded artifact" : "Artifact already uploaded");

  const template = `${JSON.stringify(
    synthesizeCloudFormationFromModel(
      withManifestHandlers(input.model, entries),
      {
        artifact: { bucket, key: bundleKey },
      }
    ),
    null,
    2
  )}\n`;
  const templateKey = `${input.config.name}/${input.stage}/template-${sha256Hex(template).slice(0, 16)}.json`;

  await uploadOnce(
    runtime,
    bucket,
    templateKey,
    new TextEncoder().encode(template),
    "application/json"
  );
  runtime.output(
    input.dryRun
      ? `Planning changes for stack ${stackName}`
      : `Deploying stack ${stackName}`
  );

  const result = await deployStack(runtime, {
    dryRun: input.dryRun,
    stackName,
    template: { url: runtime.clients.objectUrl(bucket, templateKey) },
  });

  if (result.status === "deployed") {
    runtime.output(
      `Deployed in ${Math.round((runtime.now() - started) / 1000)}s`
    );
  } else if (result.status === "unchanged") {
    runtime.output("No changes");
  }

  return { ...result, id: stackName, region };
};

export const removeAwsStack = async (
  input: ProviderRemoveInput,
  deps: DeployDependencies
): Promise<{ status: "absent" | "removed" }> => {
  const runtime = runtimeFor(deps, input.output);
  const stackName = `${input.config.name}-${input.stage}`;

  if ((await runtime.clients.describeStack(stackName)) === undefined) {
    return { status: "absent" };
  }

  runtime.output(`Removing stack ${stackName}`);
  await deleteStackAndWait(runtime, stackName);

  return { status: "removed" };
};
