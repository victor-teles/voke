import { voke } from "../src/app";
import { defineConfig } from "../src/config";
import { createFunctions, fn, http } from "../src/invoke";
import type { StandardSchemaV1 } from "../src/invoke";
import type {
  FunctionExecution,
  FunctionExecutionKind,
  FunctionWrap,
  VokePlugin,
} from "../src/plugin";
import { route } from "../src/route-builder";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const docsPlugin: VokePlugin = {
  cli: {
    commands: {
      export: {
        description: "Write the API description.",
        flags: { pretty: { boolean: true, description: "Indent" } },
        run: async ({ flags, loadFunctions, output }) => {
          const functions = await loadFunctions();
          const _keys: string[] = functions.map(([key]) => key);
          const _pretty: string | undefined = flags.pretty;

          output(_keys.join(","));
        },
        usage: "voke docs export",
      },
    },
    description: "API documentation.",
  },
  contributions: {
    environment: { DOCS_TITLE: "Orders" },
    functions: {
      page: http({ routes: [route.get("/docs", { handler: () => "docs" })] }),
    },
  },
  name: "docs",
  runtime: {
    setup: ({ dev, functions }) => ({
      middleware: [
        async (c, next) => {
          await next();
          c.header("x-functions", String(functions.length));
        },
      ],
      wrap: async (execution, next) => {
        const _kind: FunctionExecutionKind = execution.kind;
        const _key: string = execution.functionKey;
        const _functionName: string = execution.context.functionName;
        const _route: string | undefined = execution.route;
        const _input: unknown = execution.input;

        return dev ? await next() : await next();
      },
    }),
  },
};

// `plugins` accepts VokePlugin values and is always an array after normalization.
const config = defineConfig({ name: "orders", plugins: [docsPlugin] });
const _plugins: VokePlugin[] = config.plugins;

const functions = createFunctions({
  getOrder: fn({
    handler: (payload: { id: string }) => payload.id,
    input: schema<{ id: string }>(),
    output: schema<string>(),
  }),
  http: http({ routes: [route.get("/orders", { handler: () => [] })] }),
});

const gateway = voke(functions, { config });

void functions.invoke("getOrder", { id: "1" });
void functions.route("GET", "/orders", {});
void gateway.request("/docs");

// @ts-expect-error Plugin Functions are not part of the typed Function Registry.
void functions.invoke("docs-page");

// @ts-expect-error Plugin routes are reached through gateway.request, not functions.route.
void functions.route("GET", "/docs", {});

// @ts-expect-error Plugins are declared only in voke.config.ts, never on voke().
voke(functions, { config, plugins: [] });

const _badWrap: FunctionWrap = async (_execution: FunctionExecution, next) =>
  // @ts-expect-error next() takes no arguments, so a wrap cannot change the handler input.
  await next({});
