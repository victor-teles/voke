import { error, ok } from "./response";

export interface JsonBody<TData> {
  data: TData;
}

export interface JsonErrorBody {
  error: {
    message: string;
    code: string;
  };
}

const errorNames: Readonly<Record<number, readonly [string, string]>> = {
  400: ["BAD_REQUEST", "Bad request"],
  401: ["UNAUTHORIZED", "Unauthorized"],
  403: ["FORBIDDEN", "Forbidden"],
  404: ["NOT_FOUND", "Not found"],
  405: ["METHOD_NOT_ALLOWED", "Method not allowed"],
  409: ["CONFLICT", "Conflict"],
  413: ["PAYLOAD_TOO_LARGE", "Payload too large"],
  415: ["UNSUPPORTED_MEDIA_TYPE", "Unsupported media type"],
  422: ["UNPROCESSABLE_ENTITY", "Unprocessable entity"],
  429: ["TOO_MANY_REQUESTS", "Too many requests"],
};

const clientErrorStatus = (status: number): boolean =>
  status >= 400 && status < 500;

/** The Error Envelope `code` for an HTTP status. */
export const errorCodeForStatus = (status: number): string => {
  const named = errorNames[status];

  if (named !== undefined) {
    return named[0];
  }

  return clientErrorStatus(status) ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR";
};

/** The default Error Envelope `message` for a client error status. */
export const errorMessageForStatus = (status: number): string =>
  errorNames[status]?.[1] ?? "Bad request";

export const json = <TData>(data: TData, init?: ResponseInit): Response =>
  ok(data, init);

export const jsonError = (
  message: string,
  init: ResponseInit & { code?: string } = {}
): Response => {
  const status = init.status ?? 500;

  return error(message, {
    ...init,
    code: init.code ?? errorCodeForStatus(status),
    status,
  });
};
