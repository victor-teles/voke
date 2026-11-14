import { expect, test } from "bun:test";

import {
  createFunctions,
  createVokeModel,
  defineConfig,
  http,
  route,
} from "voke";

import { secret as secretResource } from "../src/cloudformation";
import { aws, parameter, secret } from "../src/index";

interface RoleResource {
  Properties: {
    Policies?: {
      PolicyDocument: { Statement: { Action: string[]; Resource: unknown }[] };
    }[];
  };
  Type: string;
}

const synthesize = (functions: ReturnType<typeof createFunctions>) => {
  const provider = aws();
  const config = defineConfig({
    cloudFormation: { resources: { signingKey: secretResource() } },
    name: "variables-api",
    provider,
  });

  return provider.synthesis?.synthesize?.({
    config,
    model: createVokeModel({ ...config, functions }),
  }) as {
    Resources: Record<
      string,
      RoleResource & { Properties: { Role?: unknown } }
    >;
  };
};

const statementActions = (role: RoleResource | undefined): string[] =>
  (role?.Properties.Policies ?? []).flatMap((policy) =>
    policy.PolicyDocument.Statement.flatMap((statement) => statement.Action)
  );

const statementResources = (role: RoleResource | undefined): string[] =>
  (role?.Properties.Policies ?? []).flatMap((policy) =>
    policy.PolicyDocument.Statement.map((statement) =>
      JSON.stringify(statement.Resource)
    )
  );

test("gives each Function its own role with only its Runtime Variable permissions", () => {
  const functions = createFunctions({
    http: http({
      routes: [route.get("/health", { handler: () => ({ ok: true }) })],
      variables: { apiKey: secret("/voke/api-key") },
    }),
    worker: http({
      routes: [route.get("/work", { handler: () => ({ ok: true }) })],
      variables: {
        region: parameter("/voke/region"),
        signingKey: secret.fromResource("signingKey"),
      },
    }),
  });

  const template = synthesize(functions);
  const apiRole = template.Resources.FunctionRole;
  const workerRole = template.Resources.WorkerFunctionRole;

  expect(apiRole?.Type).toBe("AWS::IAM::Role");
  expect(workerRole?.Type).toBe("AWS::IAM::Role");
  expect(template.Resources.Function?.Properties.Role).toEqual({
    "Fn::GetAtt": ["FunctionRole", "Arn"],
  });
  expect(template.Resources.WorkerFunction?.Properties.Role).toEqual({
    "Fn::GetAtt": ["WorkerFunctionRole", "Arn"],
  });

  expect(statementActions(apiRole)).toContain("secretsmanager:GetSecretValue");
  expect(statementActions(apiRole)).not.toContain("ssm:GetParameter");
  expect(statementActions(workerRole)).toContain("ssm:GetParameter");
  expect(statementActions(workerRole)).toContain(
    "secretsmanager:GetSecretValue"
  );

  expect(
    statementResources(apiRole).some((resource) =>
      resource.includes("secret:/voke/api-key-*")
    )
  ).toBe(true);
  expect(
    statementResources(workerRole).some((resource) =>
      resource.includes("secret:/voke/api-key-*")
    )
  ).toBe(false);
  expect(
    statementResources(workerRole).some((resource) =>
      resource.includes("parameter/voke/region")
    )
  ).toBe(true);
});

test("aws() supplies the AWS Runtime Variable provider", () => {
  const providers = aws().runtime?.variables?.() ?? [];

  expect(providers.map((provider) => provider.id)).toEqual(["aws"]);
});
