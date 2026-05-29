import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type {
  InvokeCommandOutput,
  LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import type {
  InvokeRequest,
  InvokeTransport,
  InvokeTransportResponse,
} from "voke";

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

const invokeCommandInput = <TPayload>(request: InvokeRequest<TPayload>) => ({
  FunctionName: request.functionName,
  InvocationType: request.invocationType,
  Payload: textEncoder.encode(JSON.stringify(request.payload)),
});

export const createAwsLambdaInvokeTransport = (
  options: AwsLambdaInvokeTransportOptions = {}
): InvokeTransport => {
  const client =
    options.client ??
    (options.clientConfig === undefined
      ? new LambdaClient()
      : new LambdaClient(options.clientConfig));

  return {
    invoke: async <TPayload>(
      request: InvokeRequest<TPayload>
    ): Promise<InvokeTransportResponse<unknown>> => {
      const response = await client.send(
        new InvokeCommand(invokeCommandInput(request))
      );

      return {
        functionError: response.FunctionError,
        payload: parseLambdaPayload(response.Payload),
        requestId: response.$metadata.requestId,
        statusCode: response.StatusCode,
      };
    },
  };
};
