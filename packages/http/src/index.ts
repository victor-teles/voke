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
