/** A minimal API Gateway HTTP API (payload v2) event for driving a built Lambda handler. */
export const createHttpApiEvent = (method: string, path: string) => {
  const url = new URL(path, "https://localhost");

  return {
    headers: {},
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
        sourceIp: "127.0.0.1",
        userAgent: "voke-test-client",
      },
      requestId: "test-request",
      routeKey: "$default",
      stage: "$default",
      time: new Date(0).toISOString(),
      timeEpoch: 0,
    },
    routeKey: "$default",
    version: "2.0",
  };
};
