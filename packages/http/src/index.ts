export interface ResponseIssue {
  message: string;
  path?: readonly PropertyKey[];
}

export interface ErrorResponseOptions extends ResponseInit {
  code?: string;
  details?: unknown;
  issues?: readonly ResponseIssue[];
}

export interface DataBody<TData> {
  data: TData;
}

export interface ErrorBody {
  error: {
    code?: string;
    details?: unknown;
    issues?: readonly ResponseIssue[];
    message: string;
  };
}

export const ok = <TData>(data: TData, init?: ResponseInit): Response =>
  Response.json({ data } satisfies DataBody<TData>, {
    status: 200,
    ...init,
  });

export const created = <TData>(data: TData, init?: ResponseInit): Response =>
  Response.json({ data } satisfies DataBody<TData>, {
    status: 201,
    ...init,
  });

export const noContent = (init?: ResponseInit): Response =>
  new Response(null, {
    status: 204,
    ...init,
  });

export const error = (
  message: string,
  options: ErrorResponseOptions = {}
): Response => {
  const { code, details, issues, ...init } = options;

  return Response.json(
    {
      error: {
        ...(code === undefined ? {} : { code }),
        ...(details === undefined ? {} : { details }),
        ...(issues === undefined ? {} : { issues }),
        message,
      },
    } satisfies ErrorBody,
    {
      ...init,
      status: init.status ?? 400,
    }
  );
};

export const response = {
  created,
  error,
  noContent,
  ok,
} as const;

export interface JsonBody<TData> {
  data: TData;
}

export interface JsonErrorBody {
  error: {
    code: string;
    message: string;
  };
}

const defaultErrorCode = (status: number): string => {
  if (status === 404) {
    return "NOT_FOUND";
  }

  if (status >= 400 && status < 500) {
    return "BAD_REQUEST";
  }

  return "INTERNAL_SERVER_ERROR";
};

export const json = <TData>(data: TData, init?: ResponseInit): Response =>
  ok(data, init);

export const jsonError = (
  message: string,
  init: ResponseInit & { code?: string } = {}
): Response => {
  const status = init.status ?? 500;

  return error(message, {
    ...init,
    code: init.code ?? defaultErrorCode(status),
    status,
  });
};
