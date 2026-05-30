import { expect, test } from "bun:test";

import {
  createFunctions,
  createVokeModel,
  defineConfig,
  http,
  route,
  voke,
} from "voke";

import { aws, createAwsClientConfig, sqsQueue } from "../src/index";

test("adds an AWS Lambda handler to a Voke Gateway", async () => {
  const functions = createFunctions({
    api: http({
      routes: [
        route.get("/health", {
          handler: () => ({ ok: true }),
        }),
      ],
    }),
  });

  const gateway = voke(functions, {
    config: { name: "health-api" },
    provider: aws(),
  }) as ReturnType<typeof voke<typeof functions>> & {
    handler: (
      event: {
        rawPath: string;
        requestContext: { http: { method: string; path: string } };
        version: "2.0";
      },
      context?: object
    ) => Promise<{ body?: string; statusCode: number }>;
  };

  const response = await gateway.handler({
    rawPath: "/health",
    requestContext: { http: { method: "GET", path: "/health" } },
    version: "2.0",
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body ?? "{}")).toEqual({ data: { ok: true } });
});

test("synthesizes CloudFormation through the AWS provider capability", () => {
  const provider = aws();
  const config = defineConfig({
    name: "provider-api",
    provider,
  });
  const template = provider.synthesis?.synthesize?.({
    config,
    model: createVokeModel(config),
  }) as { Description?: string } | undefined;

  expect(template?.Description).toBe("Voke stack for provider-api (local)");
});

test("provides AWS local dev environment through the provider capability", () => {
  const provider = aws();
  const config = defineConfig({
    name: "orders-api",
    provider,
    region: "sa-east-1",
    resources: {
      eventsQueue: sqsQueue(),
    },
  });
  const model = createVokeModel(config);
  const environment = provider.local?.devEnvironment?.({
    config,
    endpoint: "http://localhost:9999",
    model,
    region: "sa-east-1",
    stage: "local",
  });

  expect(environment).toMatchObject({
    AWS_ENDPOINT_URL: "http://localhost:9999",
    AWS_REGION: "sa-east-1",
    VOKE_LOCAL_PROVIDER: "floci",
    VOKE_RESOURCE_EVENTS_QUEUE_URL:
      "http://localhost:9999/000000000000/EventsQueue",
  });
});

test("falls back from empty string regions in AWS client config", () => {
  const previous = {
    defaultRegion: Bun.env.AWS_DEFAULT_REGION,
    region: Bun.env.AWS_REGION,
  };

  try {
    Bun.env.AWS_REGION = "";
    Bun.env.AWS_DEFAULT_REGION = "us-west-2";

    expect(createAwsClientConfig({ region: "" })).toMatchObject({
      region: "us-west-2",
    });
  } finally {
    if (previous.region === undefined) {
      delete Bun.env.AWS_REGION;
    } else {
      Bun.env.AWS_REGION = previous.region;
    }

    if (previous.defaultRegion === undefined) {
      delete Bun.env.AWS_DEFAULT_REGION;
    } else {
      Bun.env.AWS_DEFAULT_REGION = previous.defaultRegion;
    }
  }
});
