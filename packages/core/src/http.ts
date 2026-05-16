export interface JsonBody<TData> {
  data: TData;
}

export interface JsonErrorBody {
  error: {
    message: string;
    code: string;
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
  Response.json({ data } satisfies JsonBody<TData>, init);

export const jsonError = (
  message: string,
  init: ResponseInit & { code?: string } = {}
): Response => {
  const status = init.status ?? 500;

  return Response.json(
    {
      error: {
        code: init.code ?? defaultErrorCode(status),
        message,
      },
    } satisfies JsonErrorBody,
    {
      ...init,
      status,
    }
  );
};
