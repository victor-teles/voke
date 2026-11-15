import { VokeDeployError } from "voke";

import { createAwsClientConfig } from "./resources";

export interface StackDescription {
  /** The stack ARN, which names the account. */
  id?: string;
  outputs: Record<string, string>;
  status: string;
}

export interface ChangeSetInput {
  capabilities: readonly string[];
  changeSetName: string;
  stackName: string;
  /** Exactly one of templateUrl (uploaded template) or templateBody (small inline template). */
  templateBody?: string;
  templateUrl?: string;
  type: "CREATE" | "UPDATE";
}

export interface ChangeSetChange {
  action: string;
  logicalId: string;
  /** CloudFormation's `Replacement` for a Modify: "True", "False" or "Conditional". */
  replacement?: string;
  resourceType: string;
}

export interface ChangeSetDescription {
  changes: ChangeSetChange[];
  executionStatus?: string;
  status: string;
  statusReason?: string;
}

export interface StackEvent {
  id: string;
  logicalId: string;
  reason?: string;
  resourceType: string;
  status: string;
  timestamp: number;
}

/**
 * The AWS calls `voke deploy` and `voke remove` make. Tests pass fakes; the default
 * implementation loads the CloudFormation and S3 SDKs on first use.
 */
export interface DeployAwsClients {
  createChangeSet(input: ChangeSetInput): Promise<{ id: string }>;
  deleteChangeSet(id: string): Promise<void>;
  deleteStack(name: string): Promise<void>;
  describeChangeSet(id: string): Promise<ChangeSetDescription>;
  describeStack(name: string): Promise<StackDescription | undefined>;
  /** Newest first, as CloudFormation returns them. */
  describeStackEvents(name: string): Promise<StackEvent[]>;
  executeChangeSet(id: string): Promise<void>;
  objectExists(bucket: string, key: string): Promise<boolean>;
  /** The HTTPS URL CloudFormation reads an uploaded template from. */
  objectUrl(bucket: string, key: string): string;
  putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    contentType: string
  ): Promise<void>;
}

export const credentialsMessage =
  "AWS credentials were not found or have expired. Configure a profile (AWS_PROFILE), run your SSO login, or set environment credentials, then retry.";

const credentialErrorNames = new Set([
  "CredentialsProviderError",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "TokenRefreshRequired",
  "UnrecognizedClientException",
]);

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "";

const isCredentialError = (error: unknown): boolean =>
  credentialErrorNames.has(errorName(error));

const isMissingStack = (error: unknown): boolean =>
  error instanceof Error && /does not exist/u.test(error.message);

const isMissingObject = (error: unknown): boolean => {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;

  return errorName(error) === "NotFound" || status === 404;
};

/** Credential failures become one actionable message; nothing from the credentials is echoed. */
const guard = async <TResult>(
  call: () => Promise<TResult>
): Promise<TResult> => {
  try {
    return await call();
  } catch (error) {
    if (isCredentialError(error)) {
      throw new VokeDeployError(credentialsMessage, { cause: error });
    }

    throw error;
  }
};

const toRecord = (
  outputs: readonly { OutputKey?: string; OutputValue?: string }[] | undefined
): Record<string, string> =>
  Object.fromEntries(
    (outputs ?? []).flatMap((output) =>
      output.OutputKey === undefined || output.OutputValue === undefined
        ? []
        : [[output.OutputKey, output.OutputValue]]
    )
  );

const loadSdks = async () => {
  const [cloudFormation, s3] = await Promise.all([
    import("@aws-sdk/client-cloudformation"),
    import("@aws-sdk/client-s3"),
  ]);

  return { cloudFormation, s3 };
};

export const createDeployAwsClients = async (
  options: { endpoint?: string; region?: string } = {}
): Promise<DeployAwsClients> => {
  const clientConfig = createAwsClientConfig(options);
  const { cloudFormation, s3 } = await loadSdks();
  const cfn = new cloudFormation.CloudFormationClient(clientConfig);
  const storage = new s3.S3Client({
    ...clientConfig,
    forcePathStyle: clientConfig.endpoint !== undefined,
  });

  return {
    createChangeSet: async (input) =>
      await guard(async () => {
        const result = await cfn.send(
          new cloudFormation.CreateChangeSetCommand({
            Capabilities: [...input.capabilities] as never,
            ChangeSetName: input.changeSetName,
            ChangeSetType: input.type,
            StackName: input.stackName,
            TemplateBody: input.templateBody,
            TemplateURL: input.templateUrl,
          })
        );

        return { id: result.Id ?? input.changeSetName };
      }),
    deleteChangeSet: async (id) => {
      await guard(() =>
        cfn.send(
          new cloudFormation.DeleteChangeSetCommand({ ChangeSetName: id })
        )
      );
    },
    deleteStack: async (name) => {
      await guard(() =>
        cfn.send(new cloudFormation.DeleteStackCommand({ StackName: name }))
      );
    },
    describeChangeSet: async (id) =>
      await guard(async () => {
        const result = await cfn.send(
          new cloudFormation.DescribeChangeSetCommand({ ChangeSetName: id })
        );

        return {
          changes: (result.Changes ?? []).map((change) => ({
            action: change.ResourceChange?.Action ?? "",
            logicalId: change.ResourceChange?.LogicalResourceId ?? "",
            ...(change.ResourceChange?.Replacement === undefined
              ? {}
              : { replacement: change.ResourceChange.Replacement }),
            resourceType: change.ResourceChange?.ResourceType ?? "",
          })),
          executionStatus: result.ExecutionStatus,
          status: result.Status ?? "",
          statusReason: result.StatusReason,
        };
      }),
    describeStack: async (name) =>
      await guard(async () => {
        try {
          const result = await cfn.send(
            new cloudFormation.DescribeStacksCommand({ StackName: name })
          );
          const stack = result.Stacks?.[0];

          return stack === undefined
            ? undefined
            : {
                ...(stack.StackId === undefined ? {} : { id: stack.StackId }),
                outputs: toRecord(stack.Outputs),
                status: stack.StackStatus ?? "",
              };
        } catch (error) {
          if (isMissingStack(error)) {
            return;
          }

          throw error;
        }
      }),
    describeStackEvents: async (name) =>
      await guard(async () => {
        const result = await cfn
          .send(
            new cloudFormation.DescribeStackEventsCommand({ StackName: name })
          )
          .catch((error: unknown) => {
            if (isMissingStack(error)) {
              return { StackEvents: [] };
            }

            throw error;
          });

        return (result.StackEvents ?? []).map((event) => ({
          id: event.EventId ?? "",
          logicalId: event.LogicalResourceId ?? "",
          reason: event.ResourceStatusReason,
          resourceType: event.ResourceType ?? "",
          status: event.ResourceStatus ?? "",
          timestamp: event.Timestamp?.getTime() ?? 0,
        }));
      }),
    executeChangeSet: async (id) => {
      await guard(() =>
        cfn.send(
          new cloudFormation.ExecuteChangeSetCommand({ ChangeSetName: id })
        )
      );
    },
    objectExists: async (bucket, key) =>
      await guard(async () => {
        try {
          await storage.send(
            new s3.HeadObjectCommand({ Bucket: bucket, Key: key })
          );

          return true;
        } catch (error) {
          if (isMissingObject(error)) {
            return false;
          }

          throw error;
        }
      }),
    objectUrl: (bucket, key) =>
      clientConfig.endpoint === undefined
        ? `https://${bucket}.s3.${clientConfig.region}.amazonaws.com/${key}`
        : `${clientConfig.endpoint.replace(/\/+$/u, "")}/${bucket}/${key}`,
    putObject: async (bucket, key, body, contentType) => {
      await guard(() =>
        storage.send(
          new s3.PutObjectCommand({
            Body: body,
            Bucket: bucket,
            ContentType: contentType,
            Key: key,
          })
        )
      );
    },
  };
};
