import { expect, test } from "bun:test";

import { createFunctions, createVokeModel, fn, http, route } from "voke";
import type { AnyFunctionDefinition, StandardSchemaV1, VokeModel } from "voke";

import {
  dynamodbTable,
  s3Bucket,
  secret as secretResource,
  snsTopic,
  sqsQueue,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import { toLogicalId } from "../src/cloudformation-template";
import {
  aws,
  durable,
  dynamodbStream,
  eventBridge,
  kinesis,
  requestAuthorizer,
  s3,
  schedule,
  secret,
  sns,
  sqs,
} from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

interface Statement {
  Action: string[];
  Effect: string;
  Resource: unknown;
}

interface TemplateResource {
  Metadata?: { VokeFunction?: string };
  Properties: Record<string, unknown> & {
    Environment?: { Variables: Record<string, unknown> };
    Policies?: { PolicyDocument: { Statement: Statement[] } }[];
    Role?: { "Fn::GetAtt": [string, string] };
  };
  Type: string;
}

interface Template {
  Resources: Record<string, TemplateResource>;
}

const ignoreEvent = (): void => {
  // These checks only need a handler of the right type.
};

const upload = () => s3({ bucket: "uploadsBucket", handler: ignoreEvent });

const resources = {
  ordersQueue: sqsQueue(),
  ordersTopic: snsTopic(),
  signingSecret: secretResource(),
  uploadsBucket: s3Bucket(),
  usersTable: dynamodbTable(),
};

const synthesize = (functions: ReturnType<typeof createFunctions>): Template =>
  synthesizeCloudFormation({
    functions,
    name: "links",
    resources,
    stage: "test",
  }) as unknown as Template;

const roleStatements = (role: TemplateResource | undefined): Statement[] =>
  (role?.Properties.Policies ?? []).flatMap(
    (policy) => policy.PolicyDocument.Statement
  );

const lambdaVariables = (
  template: Template,
  logicalId: string
): Record<string, unknown> =>
  template.Resources[logicalId]?.Properties.Environment?.Variables ?? {};

const resourceBindingNames = (variables: Record<string, unknown>): string[] =>
  Object.keys(variables).filter((name) => name.startsWith("VOKE_RESOURCE_"));

const tableStatement = {
  Action: [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query",
    "dynamodb:Scan",
    "dynamodb:BatchGetItem",
    "dynamodb:BatchWriteItem",
    "dynamodb:ConditionCheckItem",
  ],
  Effect: "Allow",
  Resource: { "Fn::GetAtt": ["UsersTable", "Arn"] },
};

test("every Function builder keeps the resources it links", () => {
  const resourcesInput = ["usersTable", "ordersQueue"] as const;
  const definitions: Record<string, AnyFunctionDefinition> = {
    durable: durable({
      executionTimeout: { hours: 1 },
      handler: () => "ok",
      output: schema<string>(),
      resources: resourcesInput,
    }),
    dynamodbStream: dynamodbStream({
      handler: (batch) => batch.ok(),
      resources: resourcesInput,
      table: "usersTable",
    }),
    eventBridge: eventBridge({
      detail: schema<{ id: string }>(),
      handler: () => {},
      pattern: { source: ["orders"] },
      resources: resourcesInput,
    }),
    fn: fn({
      handler: () => "ok",
      output: schema<string>(),
      resources: resourcesInput,
    }),
    http: http({
      resources: resourcesInput,
      routes: [route.get("/users", { handler: () => [] })],
    }),
    kinesis: kinesis({
      handler: (batch) => batch.ok(),
      record: schema<{ id: string }>(),
      resources: resourcesInput,
      stream: "clicksStream",
    }),
    requestAuthorizer: requestAuthorizer({
      handler: () => ({ authorized: true }),
      resources: resourcesInput,
    }),
    s3: s3({
      bucket: "uploadsBucket",
      handler: () => {},
      resources: resourcesInput,
    }),
    schedule: schedule({
      expression: "rate(1 day)",
      handler: () => {},
      resources: resourcesInput,
    }),
    sns: sns({
      handler: () => {},
      message: schema<{ id: string }>(),
      resources: resourcesInput,
      topic: "ordersTopic",
    }),
    sqs: sqs({
      handler: (batch) => batch.ok(),
      message: schema<{ id: string }>(),
      queue: "ordersQueue",
      resources: resourcesInput,
    }),
  };

  expect(Object.keys(definitions)).toHaveLength(11);

  for (const [builder, definition] of Object.entries(definitions)) {
    expect({ builder, resources: definition.resources }).toEqual({
      builder,
      resources: resourcesInput,
    });
  }
});

test("only the Function that links a table gets its statement and its binding", () => {
  const template = synthesize(
    createFunctions({
      listUsers: fn({
        handler: () => "ok",
        output: schema<string>(),
        resources: ["usersTable"],
      }),
      ping: fn({ handler: () => "ok", output: schema<string>() }),
    })
  );

  expect(
    roleStatements(template.Resources.ListUsersFunctionRole)
  ).toContainEqual(tableStatement);
  expect(lambdaVariables(template, "ListUsersFunction")).toMatchObject({
    VOKE_RESOURCE_USERS_TABLE_NAME: { Ref: "UsersTable" },
  });
  expect(template.Resources.PingFunctionRole?.Properties.Policies).toBe(
    undefined
  );
  expect(
    resourceBindingNames(lambdaVariables(template, "PingFunction"))
  ).toEqual([]);
});

// The logical ids of model resources a value references through Ref, Fn::GetAtt or Fn::Sub.
const referencedResources = (
  value: unknown,
  resourceIds: ReadonlySet<string>
): Set<string> => {
  const found = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const id of resourceIds) {
        if (item === id || item.includes(`\${${id}`)) {
          found.add(id);
        }
      }

      return;
    }

    if (Array.isArray(item)) {
      for (const entry of item) {
        visit(entry);
      }

      return;
    }

    if (typeof item === "object" && item !== null) {
      for (const entry of Object.values(item)) {
        visit(entry);
      }
    }
  };

  visit(value);

  return found;
};

// What a Function may reach: its links, its Event Sources' trigger resources and the resources
// its Runtime Variables read.
const allowedResources = (fnModel: VokeModel["functions"][string]): string[] =>
  [
    ...fnModel.links,
    ...fnModel.eventSources.flatMap((source) =>
      source.resource === undefined ? [] : [source.resource]
    ),
    ...fnModel.bindings.map((binding) => binding.resource),
  ].map(toLogicalId);

test("no role names a resource its Function did not link, trigger or read through a Runtime Variable", () => {
  const functions = createFunctions({
    consumeOrders: sqs({
      handler: (batch) => batch.ok(),
      message: schema<{ id: string }>(),
      queue: "ordersQueue",
    }),
    listUsers: fn({
      handler: () => "ok",
      output: schema<string>(),
      resources: ["usersTable"],
    }),
    onUpload: s3({
      bucket: "uploadsBucket",
      handler: () => {},
      resources: ["usersTable"],
    }),
    sign: fn({
      handler: () => "ok",
      output: schema<string>(),
      variables: { key: secret.fromResource("signingSecret") },
    }),
  });
  const model = createVokeModel({
    functions,
    name: "links",
    provider: aws(),
    resources,
    stage: "test",
  });
  const template = synthesize(functions);
  const resourceIds = new Set(Object.keys(resources).map(toLogicalId));
  let checkedRoles = 0;

  for (const resource of Object.values(template.Resources)) {
    const functionKey = resource.Metadata?.VokeFunction;
    const roleId = resource.Properties.Role?.["Fn::GetAtt"][0];

    if (
      resource.Type !== "AWS::Lambda::Function" ||
      functionKey === undefined
    ) {
      continue;
    }

    const fnModel = model.functions[functionKey];

    if (fnModel === undefined || roleId === undefined) {
      throw new Error(`Function ${functionKey} has no model or role`);
    }

    const referenced = referencedResources(
      roleStatements(template.Resources[roleId]),
      resourceIds
    );

    const allowed = allowedResources(fnModel);
    const unlinked = [...referenced].filter((id) => !allowed.includes(id));

    expect({ functionKey, unlinked }).toEqual({ functionKey, unlinked: [] });
    checkedRoles += 1;
  }

  expect(checkedRoles).toBe(4);
});

test("an SQS Event Source Function that links nothing may only consume its queue", () => {
  const consume = () =>
    sqs({
      handler: (batch) => batch.ok(),
      message: schema<{ id: string }>(),
      queue: "ordersQueue",
    });
  const template = synthesize(createFunctions({ consumeOrders: consume() }));
  const statements = roleStatements(
    template.Resources.ConsumeOrdersFunctionRole
  );

  expect(statements).toEqual([
    {
      Action: [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
      ],
      Effect: "Allow",
      Resource: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
    },
  ]);
  expect(
    resourceBindingNames(lambdaVariables(template, "ConsumeOrdersFunction"))
  ).toEqual([]);

  const linked = synthesize(
    createFunctions({
      consumeOrders: { ...consume(), resources: ["ordersQueue"] },
    })
  );

  expect(
    roleStatements(linked.Resources.ConsumeOrdersFunctionRole)
  ).toContainEqual({
    Action: [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ],
    Effect: "Allow",
    Resource: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
  });
  expect(lambdaVariables(linked, "ConsumeOrdersFunction")).toMatchObject({
    VOKE_RESOURCE_ORDERS_QUEUE_URL: { Ref: "OrdersQueue" },
  });
});

test("an S3 Event Source Function reads its bucket only when it links it", () => {
  const s3Actions = (template: Template): string[] =>
    roleStatements(template.Resources.OnUploadFunctionRole)
      .flatMap((statement) => statement.Action)
      .filter((action) => action.startsWith("s3:"));

  expect(
    s3Actions(synthesize(createFunctions({ onUpload: upload() })))
  ).toEqual([]);

  const linked = synthesize(
    createFunctions({
      onUpload: { ...upload(), resources: ["uploadsBucket"] },
    })
  );
  const statements = roleStatements(linked.Resources.OnUploadFunctionRole);

  expect(statements).toContainEqual({
    Action: ["s3:ListBucket"],
    Effect: "Allow",
    Resource: { "Fn::GetAtt": ["UploadsBucket", "Arn"] },
  });
  expect(statements).toContainEqual({
    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
    Effect: "Allow",
    Resource: { "Fn::Sub": [`\${UploadsBucket.Arn}/*`, {}] },
  });
});

test("a fromResource Runtime Variable keeps its read statement and binding, once, with or without a link", () => {
  const secretStatement = {
    Action: ["secretsmanager:GetSecretValue"],
    Effect: "Allow",
    Resource: { "Fn::GetAtt": ["SigningSecret", "Arn"] },
  };
  const sign = (links: readonly string[]) =>
    fn({
      handler: () => "ok",
      output: schema<string>(),
      resources: links,
      variables: { key: secret.fromResource("signingSecret") },
    });

  for (const links of [[], ["signingSecret"]]) {
    const template = synthesize(createFunctions({ sign: sign(links) }));

    expect(roleStatements(template.Resources.SignFunctionRole)).toEqual([
      secretStatement,
    ]);
    expect(lambdaVariables(template, "SignFunction")).toMatchObject({
      VOKE_RESOURCE_SIGNING_SECRET_ID: {
        "Fn::GetAtt": ["SigningSecret", "Id"],
      },
    });
  }
});

test("dynamodbTable() grants batch and condition-check item actions", () => {
  expect(dynamodbTable().actions).toEqual(tableStatement.Action);
});
