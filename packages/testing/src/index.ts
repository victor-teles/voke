import { activateFunctionRegistry } from "voke";
import type { FunctionRegistry } from "voke";

type FetchLike = (request: Request) => Response | Promise<Response>;
type TestHeaders = HeadersInit;
type TestBody = string | ArrayBuffer | Blob | FormData | URLSearchParams;

export type TestClientTarget =
  | {
      fetch: FetchLike;
    }
  | {
      baseUrl: string;
      fetch?: FetchLike;
    };

export interface TestRequestOptions {
  body?: TestBody | null;
  headers?: TestHeaders;
  json?: unknown;
}

export interface TestClient {
  delete: (path: string, options?: TestRequestOptions) => Promise<Response>;
  get: (path: string, options?: TestRequestOptions) => Promise<Response>;
  patch: (path: string, options?: TestRequestOptions) => Promise<Response>;
  post: (path: string, options?: TestRequestOptions) => Promise<Response>;
  put: (path: string, options?: TestRequestOptions) => Promise<Response>;
  request: (
    method: string,
    path: string,
    options?: TestRequestOptions
  ) => Promise<Response>;
}

const requestBody = (
  options: TestRequestOptions
): { body?: BodyInit; headers: Headers } => {
  const headers = new Headers(options.headers);

  if (options.json !== undefined) {
    headers.set("content-type", "application/json");

    return {
      body: JSON.stringify(options.json),
      headers,
    };
  }

  return {
    ...(options.body === undefined || options.body === null
      ? {}
      : { body: options.body }),
    headers,
  };
};

const targetUrl = (target: TestClientTarget, path: string): string => {
  if ("baseUrl" in target) {
    return new URL(path, target.baseUrl).toString();
  }

  return new URL(path, "https://localhost").toString();
};

const targetFetch = (target: TestClientTarget): FetchLike => {
  if ("baseUrl" in target && target.fetch !== undefined) {
    return target.fetch;
  }

  if ("fetch" in target && target.fetch !== undefined) {
    return target.fetch;
  }

  return fetch;
};

export const createTestClient = (target: TestClientTarget): TestClient => {
  const request = async (
    method: string,
    path: string,
    options: TestRequestOptions = {}
  ): Promise<Response> => {
    const body = requestBody(options);

    return await targetFetch(target)(
      new Request(targetUrl(target, path), {
        ...body,
        method,
      })
    );
  };

  return {
    delete: (path, options) => request("DELETE", path, options),
    get: (path, options) => request("GET", path, options),
    patch: (path, options) => request("PATCH", path, options),
    post: (path, options) => request("POST", path, options),
    put: (path, options) => request("PUT", path, options),
    request,
  };
};

export const createInvokeTestClient = <TFunctions extends FunctionRegistry>(
  functions: TFunctions
): Pick<TFunctions, "invoke"> => ({
  invoke:
    (activateFunctionRegistry(functions, "invoke-test-client"),
    functions.invoke.bind(functions) as TFunctions["invoke"]),
});
