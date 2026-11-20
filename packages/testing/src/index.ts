import { activateFunctionRegistry } from "voke";
import type { FunctionRegistry, JwtAuthorizerDefinition } from "voke";

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
    // Append rather than resolve, so a stage path such as `/prod` survives `/users`.
    const base = target.baseUrl.endsWith("/")
      ? target.baseUrl.slice(0, -1)
      : target.baseUrl;

    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
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

const BASE64_PLUS = /\+/gu;
const BASE64_SLASH = /\//gu;
const BASE64_PADDING = /=+$/u;
const TEST_JWT_LIFETIME_SECONDS = 3600;

const base64url = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary)
    .replace(BASE64_PLUS, "-")
    .replace(BASE64_SLASH, "_")
    .replace(BASE64_PADDING, "");
};

/**
 * Mints an unsigned JWT that Local Authorizer Evaluation accepts for the given JWT Authorizer.
 * Defaults: iss and aud from the authorizer, sub "test-user", iat now, exp one hour later.
 * `claims` override or add claims; a claim set to undefined is left out. API Gateway rejects
 * this token: it has no signature.
 */
export const createTestJwt = (
  authorizer: Pick<JwtAuthorizerDefinition, "audience" | "issuer">,
  claims: Record<string, unknown> = {}
): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.fromEntries(
    Object.entries({
      aud: authorizer.audience[0],
      exp: now + TEST_JWT_LIFETIME_SECONDS,
      iat: now,
      iss: authorizer.issuer,
      sub: "test-user",
      ...claims,
    }).filter(([, value]) => value !== undefined)
  );

  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(payload)}.`;
};
