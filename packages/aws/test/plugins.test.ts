import { expect, test } from "bun:test";

import {
  createFunctions,
  createVokeModel,
  defineConfig,
  fn,
  http,
  route,
  VokeModelError,
} from "voke";
import type { StandardSchemaV1, VokePlugin } from "voke";

import { sqsQueue } from "../src/cloudformation";
import { aws, awsPolicy } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

interface TemplateResource {
  Properties: Record<string, unknown> & {
    Environment?: { Variables: Record<string, unknown> };
    Policies?: {
      PolicyDocument: { Statement: Record<string, unknown>[] };
    }[];
    RouteKey?: string;
    Target?: unknown;
  };
  Type: string;
}

const auditPlugin = (): VokePlugin => ({
  contributions: {
    functions: {
      docs: http({
        routes: [route.get("/docs", { handler: () => ({ docs: true }) })],
      }),
    },
    provider: awsPolicy({
      statements: [
        { actions: ["s3:GetObject"], resources: ["arn:aws:s3:::audit/*"] },
      ],
    }),
    resources: { auditQueue: sqsQueue() },
  },
  name: "audit",
});

const synthesize = (plugins: VokePlugin[]) => {
  const provider = aws();
  const config = defineConfig({
    name: "shop",
    plugins,
    provider,
    stage: "dev",
  });
  const functions = createFunctions({
    http: http({ routes: [route.get("/", { handler: () => "home" })] }),
    report: fn({ handler: () => "done", output: schema<string>() }),
  });

  return provider.synthesis?.synthesize?.({
    config,
    model: createVokeModel({ ...config, functions }),
  }) as { Resources: Record<string, TemplateResource> };
};

const statements = (resource: TemplateResource | undefined) =>
  (resource?.Properties.Policies ?? []).flatMap(
    (policy) => policy.PolicyDocument.Statement
  );

test("awsPolicy builds the AWS Provider Extension Record of a Plugin", () => {
  expect(
    awsPolicy({ statements: [{ actions: ["s3:GetObject"], resources: ["*"] }] })
  ).toEqual({
    aws: {
      properties: {
        statements: [{ actions: ["s3:GetObject"], resources: ["*"] }],
      },
      type: "iam.policy",
    },
  });
});

test("synthesizes a Plugin Function, its API route and the contributed resource", () => {
  const { Resources } = synthesize([auditPlugin()]);
  const pluginFunction = Resources.AuditDocsFunction;

  expect(pluginFunction?.Type).toBe("AWS::Lambda::Function");
  expect(pluginFunction?.Properties.FunctionName).toBe("shop-dev-audit-docs");
  expect(pluginFunction?.Properties.Handler).toBe("index.auditDocs");

  const routes = Object.values(Resources).filter(
    (resource) => resource.Type === "AWS::ApiGatewayV2::Route"
  );

  expect(routes.map((resource) => resource.Properties.RouteKey)).toContain(
    "GET /docs"
  );
  expect(Resources.AuditQueue?.Type).toBe("AWS::SQS::Queue");

  for (const name of ["Function", "ReportFunction", "AuditDocsFunction"]) {
    expect(
      Object.keys(Resources[name]?.Properties.Environment?.Variables ?? {})
    ).toContain("VOKE_RESOURCE_AUDIT_QUEUE_URL");
  }
});

test("adds the awsPolicy statements to every Function role", () => {
  const { Resources } = synthesize([auditPlugin()]);
  const roles = Object.values(Resources).filter(
    (resource) => resource.Type === "AWS::IAM::Role"
  );

  expect(roles).toHaveLength(3);

  for (const role of roles) {
    expect(statements(role)).toContainEqual({
      Action: ["s3:GetObject"],
      Effect: "Allow",
      Resource: ["arn:aws:s3:::audit/*"],
    });
  }
});

test("a project without Plugins synthesizes as before", () => {
  const { Resources } = synthesize([]);

  expect(Object.keys(Resources).some((key) => key.startsWith("Audit"))).toBe(
    false
  );
});

const issuesOf = (plugin: VokePlugin): unknown => {
  try {
    createVokeModel({ name: "shop", plugins: [plugin], provider: aws() });
  } catch (error) {
    expect(error).toBeInstanceOf(VokeModelError);

    return (error as VokeModelError & { issues?: unknown }).issues;
  }

  throw new Error("expected a VokeModelError");
};

test("an invalid AWS Plugin record fails at its contribution path", () => {
  expect(
    issuesOf({
      contributions: {
        provider: { aws: { properties: {}, type: "cloudformation.template" } },
      },
      name: "raw",
    })
  ).toEqual([
    {
      message:
        'expected "iam.policy" (use awsPolicy() from "@voke/aws"); received "cloudformation.template"',
      path: "plugins.raw.contributions.provider.aws.type",
    },
  ]);
  expect(
    issuesOf({
      contributions: {
        provider: awsPolicy({
          statements: [
            { actions: [], resources: ["*"] },
            { actions: ["s3:GetObject"], resources: [42 as unknown as string] },
          ],
        }),
      },
      name: "raw",
    })
  ).toEqual([
    {
      message: "expected a non-empty array of strings; received []",
      path: "plugins.raw.contributions.provider.aws.properties.statements.0.actions",
    },
    {
      message: "expected a non-empty array of strings; received [42]",
      path: "plugins.raw.contributions.provider.aws.properties.statements.1.resources",
    },
  ]);
});

test("Plugin records for other Providers are ignored", () => {
  expect(() =>
    createVokeModel({
      name: "shop",
      plugins: [
        {
          contributions: {
            provider: { other: { properties: {}, type: "anything" } },
          },
          name: "elsewhere",
        },
      ],
      provider: aws(),
    })
  ).not.toThrow();
});
