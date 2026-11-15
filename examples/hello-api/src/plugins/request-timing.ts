import type { VokePlugin } from "voke";

// Handler time per HTTP request, from the wrap to the middleware that answers it.
const handlerMs = new WeakMap<Request, number>();

const isRouteRequest = (input: unknown): input is { raw: Request } =>
  typeof input === "object" &&
  input !== null &&
  "raw" in input &&
  input.raw instanceof Request;

/**
 * Measures every Function handler and reports the time of a route handler in an
 * `x-handler-ms` response header.
 */
export const requestTiming = (): VokePlugin => ({
  name: "request-timing",
  runtime: {
    setup: () => ({
      middleware: [
        async (c, next) => {
          await next();

          const ms = handlerMs.get(c.req.raw);

          if (ms !== undefined) {
            c.header("x-handler-ms", ms.toFixed(2));
          }
        },
      ],
      wrap: async (execution, next) => {
        const started = performance.now();

        try {
          return await next();
        } finally {
          if (execution.kind === "route" && isRouteRequest(execution.input)) {
            handlerMs.set(execution.input.raw, performance.now() - started);
          }
        }
      },
    }),
  },
});
