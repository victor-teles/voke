import type {
  InvokeCommand,
  InvokeCommandOutput,
  LambdaClient,
  LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import type {
  InvokeRequest,
  InvokeTransport,
  InvokeTransportResponse,
  ProviderInvokeCapability,
} from "voke";

import { durableInvokeTarget, isDurableFunction } from "./durable";

export interface AwsLambdaInvokeClient {
  send(command: InvokeCommand): Promise<InvokeCommandOutput>;
}

export interface AwsLambdaInvokeTransportOptions {
  client?: AwsLambdaInvokeClient;
  clientConfig?: LambdaClientConfig;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const parseLambdaPayload = (payload: unknown): unknown => {
  if (payload === undefined) {
    return undefined;
  }

  if (payload instanceof Uint8Array) {
    const text = textDecoder.decode(payload);
    return text === "" ? undefined : JSON.parse(text);
  }

  if (typeof payload === "string") {
    return payload === "" ? undefined : JSON.parse(payload);
  }

  return payload;
};

interface LambdaSdk {
  InvokeCommand: typeof InvokeCommand;
  LambdaClient: typeof LambdaClient;
}

// The SDK is loaded on first invoke so Gateways that never call a deployed Function
// do not pay for it at cold start. Lambda bundles keep @aws-sdk/* external and use
// the SDK that ships with the Lambda Node.js runtime.
const loadLambdaSdk = (): Promise<LambdaSdk> =>
  import("@aws-sdk/client-lambda");

const invokeCommandInput = <TPayload>(request: InvokeRequest<TPayload>) => ({
  ...(request.executionName === undefined
    ? {}
    : { DurableExecutionName: request.executionName }),
  FunctionName: request.functionName,
  InvocationType: request.invocationType,
  Payload: textEncoder.encode(JSON.stringify(request.payload)),
});

export const createAwsLambdaInvokeTransport = (
  options: AwsLambdaInvokeTransportOptions = {}
): InvokeTransport => {
  let sdk: Promise<LambdaSdk> | undefined;
  let { client } = options;

  return {
    invoke: async <TPayload>(
      request: InvokeRequest<TPayload>
    ): Promise<InvokeTransportResponse<unknown>> => {
      sdk ??= loadLambdaSdk();
      const { InvokeCommand, LambdaClient } = await sdk;

      client ??=
        options.clientConfig === undefined
          ? new LambdaClient()
          : new LambdaClient(options.clientConfig);

      const response = await client.send(
        new InvokeCommand(invokeCommandInput(request))
      );

      return {
        ...(response.DurableExecutionArn === undefined
          ? {}
          : { executionId: response.DurableExecutionArn }),
        functionError: response.FunctionError,
        payload: parseLambdaPayload(response.Payload),
        requestId: response.$metadata.requestId,
        statusCode: response.StatusCode,
      };
    },
  };
};

/**
 * The AWS Provider's invoke capability: deployed Durable Functions start through Lambda at their
 * `live` alias; every other Function runs in-process. The transport is created once, so its
 * Lambda client and connections are reused.
 */
export const createAwsInvokeCapability = (): ProviderInvokeCapability => {
  let transport: InvokeTransport | undefined;

  return {
    // Durable Functions take an execution name; a local run, which has no Lambda to name, ignores it.
    acceptsExecutionName: ({ definition }) => isDurableFunction(definition),
    target: durableInvokeTarget,
    transport: () => {
      transport ??= createAwsLambdaInvokeTransport();

      return transport;
    },
  };
};
