import type { VokeApi } from "./api";
import { handleAwsLambdaRequest } from "./aws-lambda";
import type {
  AwsLambdaContext,
  AwsLambdaHttpApiV2Event,
  HonoLikeApp,
} from "./aws-lambda";
import type { CloudFormationTemplate } from "./cloudformation";
import { toEnvKey } from "./env-key";
import { createInvoker, invoke } from "./invoke";
import type {
  AsyncInvokeResult,
  FunctionDefinition,
  FunctionRegistry,
  InvokeOptions,
} from "./invoke";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "./local";
import type { LocalAwsEnvironment } from "./local";

type FetchLike = (request: Request) => Response | Promise<Response>;
type TestHeaders = HeadersInit;
type TestBody = string | ArrayBuffer | Blob | FormData | URLSearchParams;

export type TestClientTarget =
  | HonoLikeApp
  | VokeApi
  | {
      baseUrl: string;
      fetch?: FetchLike;
    };

export interface TestRequestOptions {
  headers?: TestHeaders;
  body?: TestBody | null;
  json?: unknown;
  context?: Partial<AwsLambdaContext>;
}

export interface TestClient {
  request: (
    method: string,
    path: string,
    options?: TestRequestOptions
  ) => Promise<Response>;
  get: (path: string, options?: TestRequestOptions) => Promise<Response>;
  post: (path: string, options?: TestRequestOptions) => Promise<Response>;
  put: (path: string, options?: TestRequestOptions) => Promise<Response>;
  patch: (path: string, options?: TestRequestOptions) => Promise<Response>;
  delete: (path: string, options?: TestRequestOptions) => Promise<Response>;
}

export interface StackTestContextOptions {
  template: CloudFormationTemplate;
  endpoint?: string;
  region?: string;
  accountId?: string;
  outputs?: Record<string, string>;
}

export interface StackSeedInput {
  dynamodb?: Record<string, Record<string, unknown>[]>;
  sqs?: Record<string, unknown[]>;
}

export interface StackSeedPlan {
  environment: LocalAwsEnvironment;
  commands: string[][];
}

export interface StackTestContext {
  template: CloudFormationTemplate;
  environment: LocalAwsEnvironment;
  bindings: Record<string, string>;
  outputs: Record<string, string>;
  resource: (name: string, attribute: string) => string;
  output: (name: string) => string;
  createSeedPlan: (input: StackSeedInput) => StackSeedPlan;
}

type InferPayload<TDefinition> =
  TDefinition extends FunctionDefinition<string, infer TPayload, infer _TResult>
    ? TPayload
    : never;

type InferResult<TDefinition> =
  TDefinition extends FunctionDefinition<string, infer _TPayload, infer TResult>
    ? TResult
    : never;

type Requester = (
  method: string,
  path: string,
  options?: TestRequestOptions
) => Promise<Response>;

type UntypedInvoker = (
  functionName: string,
  payload: unknown,
  options?: InvokeOptions
) => Promise<unknown>;

type UntypedAsyncInvoker = (
  functionName: string,
  payload: unknown,
  options?: InvokeOptions
) => Promise<AsyncInvokeResult>;

type InvokeRegistry = Record<string, unknown>;

export interface InvokeTestClient<TRegistry = undefined> {
  invoke: TRegistry extends InvokeRegistry
    ? <TName extends keyof TRegistry & string>(
        functionName: TName,
        payload: InferPayload<TRegistry[TName]>,
        options?: InvokeOptions
      ) => Promise<Awaited<InferResult<TRegistry[TName]>>>
    : <TPayload, TResult>(
        functionName: string,
        payload: TPayload,
        options?: InvokeOptions
      ) => Promise<TResult>;
  invokeAsync: TRegistry extends InvokeRegistry
    ? <TName extends keyof TRegistry & string>(
        functionName: TName,
        payload: InferPayload<TRegistry[TName]>,
        options?: Omit<InvokeOptions, "mode">
      ) => Promise<AsyncInvokeResult>
    : <TPayload>(
        functionName: string,
        payload: TPayload,
        options?: Omit<InvokeOptions, "mode">
      ) => Promise<AsyncInvokeResult>;
}

const isRemoteTarget = (
  target: TestClientTarget
): target is { baseUrl: string; fetch?: FetchLike } => "baseUrl" in target;

const joinUrl = (baseUrl: string, path: string): string => {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const nextPath = path.startsWith("/") ? path : `/${path}`;

  return `${base}${nextPath}`;
};

const requestBody = (
  options: TestRequestOptions
): string | TestBody | undefined => {
  if (options.json !== undefined) {
    return JSON.stringify(options.json);
  }
  if (options.body === null) {
    return undefined;
  }

  return options.body;
};

const headersRecord = (
  headers: TestHeaders | undefined
): Record<string, string> => {
  const record: Record<string, string> = {};

  for (const [key, value] of new Headers(headers).entries()) {
    record[key.toLowerCase()] = value;
  }

  if (record.host === undefined) {
    record.host = "localhost";
  }
  if (record["x-forwarded-proto"] === undefined) {
    record["x-forwarded-proto"] = "https";
  }
  if (record["content-type"] === undefined) {
    record["content-type"] = "application/json";
  }

  return record;
};

const responseHeaders = (
  headers: Record<string, string | number | boolean> | undefined
): Record<string, string> => {
  if (headers === undefined) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)])
  );
};

const toDynamoAttribute = (
  value: unknown
): Record<string, string | boolean> => {
  if (typeof value === "number") {
    return { N: String(value) };
  }
  if (typeof value === "boolean") {
    return { BOOL: value };
  }
  if (value === null) {
    return { NULL: true };
  }

  return { S: String(value) };
};

const toDynamoItem = (
  item: Record<string, unknown>
): Record<string, Record<string, string | boolean>> =>
  Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, toDynamoAttribute(value)])
  );

const stringifyOutput = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
};

const resolveOutputs = (
  template: CloudFormationTemplate,
  overrides: Record<string, string> = {}
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(template.Outputs).map(([name, output]) => [
      name,
      stringifyOutput(output.Value),
    ])
  ),
  ...overrides,
});

export const createHttpApiEvent = (
  method: string,
  path: string,
  options: TestRequestOptions = {}
): AwsLambdaHttpApiV2Event => {
  const url = new URL(path, "https://localhost");
  const headers = headersRecord(options.headers);
  const body = requestBody(options);

  return {
    headers,
    isBase64Encoded: false,
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    requestContext: {
      accountId: "000000000000",
      apiId: "local",
      domainName: "localhost",
      domainPrefix: "localhost",
      http: {
        method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: headers["x-forwarded-for"] ?? "127.0.0.1",
        userAgent: headers["user-agent"] ?? "voke-test-client",
      },
      requestId: headers["x-request-id"] ?? "test-request",
      routeKey: "$default",
      stage: "$default",
      time: new Date(0).toISOString(),
      timeEpoch: 0,
    },
    routeKey: "$default",
    version: "2.0",
    ...(body === undefined ? {} : { body }),
  } as AwsLambdaHttpApiV2Event;
};

const createLocalRequester = (target: HonoLikeApp | VokeApi): Requester => {
  const app = "app" in target ? target.app : target;

  return async (
    method: string,
    path: string,
    options: TestRequestOptions = {}
  ) => {
    const result = await handleAwsLambdaRequest(
      app,
      createHttpApiEvent(method, path, options),
      options.context
    );

    return new Response(result.body, {
      headers: responseHeaders(result.headers),
      status: result.statusCode,
    });
  };
};

const createRemoteRequester = (target: {
  baseUrl: string;
  fetch?: FetchLike;
}): Requester => {
  const fetcher = target.fetch ?? fetch;

  return (method: string, path: string, options: TestRequestOptions = {}) => {
    const headers = new Headers(options.headers);
    const body = requestBody(options);

    if (options.json !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return Promise.resolve(
      fetcher(
        new Request(joinUrl(target.baseUrl, path), {
          headers,
          method,
          ...(body === undefined ? {} : { body }),
        })
      )
    );
  };
};

const createSeedPlan = (
  input: StackSeedInput,
  environment: LocalAwsEnvironment,
  bindings: Record<string, string>
): StackSeedPlan => {
  const commands: string[][] = [];

  for (const [tableName, items] of Object.entries(input.dynamodb ?? {})) {
    for (const item of items) {
      commands.push([
        "aws",
        "dynamodb",
        "put-item",
        "--table-name",
        tableName,
        "--item",
        JSON.stringify(toDynamoItem(item)),
        "--region",
        environment.AWS_REGION,
      ]);
    }
  }

  for (const [queueName, messages] of Object.entries(input.sqs ?? {})) {
    const queueUrl =
      bindings[`VOKE_RESOURCE_${toEnvKey(queueName)}_URL`] ?? queueName;

    for (const message of messages) {
      commands.push([
        "aws",
        "sqs",
        "send-message",
        "--queue-url",
        queueUrl,
        "--message-body",
        JSON.stringify(message),
        "--region",
        environment.AWS_REGION,
      ]);
    }
  }

  return { commands, environment };
};

export const createTestClient = (target: TestClientTarget): TestClient => {
  const request = isRemoteTarget(target)
    ? createRemoteRequester(target)
    : createLocalRequester(target);

  return {
    delete: (path, options) => request("DELETE", path, options),
    get: (path, options) => request("GET", path, options),
    patch: (path, options) => request("PATCH", path, options),
    post: (path, options) => request("POST", path, options),
    put: (path, options) => request("PUT", path, options),
    request,
  };
};

export const createStackTestContext = (
  options: StackTestContextOptions
): StackTestContext => {
  const environment = createLocalAwsEnvironment({
    endpoint: options.endpoint,
    region: options.region,
  });
  const bindings = createLocalResourceBindings(options.template, {
    accountId: options.accountId,
    endpoint: environment.AWS_ENDPOINT_URL,
    region: environment.AWS_REGION,
  });
  const outputs = resolveOutputs(options.template, options.outputs);

  return {
    bindings,
    createSeedPlan: (input) => createSeedPlan(input, environment, bindings),
    environment,
    output: (name) => {
      const value = outputs[name];

      if (value === undefined) {
        throw new Error(`Missing stack test output: ${name}`);
      }

      return value;
    },
    outputs,
    resource: (name, attribute) => {
      const envName = `VOKE_RESOURCE_${toEnvKey(name)}_${toEnvKey(attribute)}`;
      const value = bindings[envName];

      if (value === undefined) {
        throw new Error(`Missing stack test resource binding: ${envName}`);
      }

      return value;
    },
    template: options.template,
  };
};

export const createInvokeTestClient = <
  TRegistry extends InvokeRegistry | undefined = undefined,
>(
  registry?: TRegistry
): InvokeTestClient<TRegistry> => {
  const registryInvoker =
    registry === undefined
      ? undefined
      : createInvoker(registry as FunctionRegistry);

  return {
    invoke: ((
      functionName: string,
      payload: unknown,
      options?: InvokeOptions
    ) => {
      if (registryInvoker !== undefined) {
        return (registryInvoker as UntypedInvoker)(
          functionName,
          payload,
          options
        );
      }

      return invoke(functionName, payload, options);
    }) as InvokeTestClient<TRegistry>["invoke"],
    invokeAsync: ((
      functionName: string,
      payload: unknown,
      options?: Omit<InvokeOptions, "mode">
    ) => {
      if (registryInvoker !== undefined) {
        return (registryInvoker as UntypedAsyncInvoker)(functionName, payload, {
          ...options,
          mode: "async",
        });
      }

      return invoke(functionName, payload, { ...options, mode: "async" });
    }) as InvokeTestClient<TRegistry>["invokeAsync"],
  };
};
