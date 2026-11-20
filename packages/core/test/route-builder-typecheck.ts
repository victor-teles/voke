import { voke } from "../src/app";
import { fn, createFunctions } from "../src/invoke";
import type { RouteMeta, StandardSchemaV1 } from "../src/invoke";
import { Voke } from "../src/route-builder";

const schema = <TInput, TOutput = TInput>(): StandardSchemaV1<
  TInput,
  TOutput
> => ({
  "~standard": {
    validate: (value) => ({ value: value as unknown as TOutput }),
    vendor: "voke-test",
    version: 1,
  },
});

const app = new Voke();
const getUserRoute = app.get("/users/:id", {
  body: schema<unknown, { ignored?: true }>(),
  handler: (req) => ({
    id: req.params.id,
    includePosts: req.query.includePosts,
    requestId: req.headers["x-request-id"],
  }),
  headers: schema<Record<string, string>, { "x-request-id": string }>(),
  params: schema<{ id: string }>(),
  query: schema<Record<string, string>, { includePosts: boolean }>(),
});
const createUserRoute = app.post("/users", {
  body: schema<{ name: string }>(),
  handler: (req) => ({ id: "usr_1", name: req.body.name }),
  output: schema<{ id: string; name: string }>(),
});
const healthRoute = app.get("/health", {
  handler: () => ({ ok: true }),
  output: schema<{ ok: boolean }>(),
});

// Without query and headers schemas, both are plain records of optional strings.
const plainRoute = app.get("/plain", {
  handler: (req) => {
    const { page } = req.query;
    const requestId: string | undefined = req.headers["x-request-id"];
    // @ts-expect-error a query value may be missing.
    const _required: string = req.query.page;

    return { page, requestId };
  },
});

const functions = createFunctions({
  health: fn({
    handler: () => ({ ok: true }),
    output: schema<{ ok: boolean }>(),
  }),
  lookupUser: fn({
    handler: (payload) => ({ id: payload.id, name: "Victor" }),
    input: schema<{ id: string }>(),
    output: schema<{ id: string; name: string }>(),
  }),
  users: fn({
    routes: [getUserRoute, createUserRoute, healthRoute, plainRoute],
  }),
});

const _usersKind: "route" = functions.users.kind;

const _getUser: Promise<{
  id: string;
  includePosts: boolean;
  requestId: string;
}> = functions.route("GET", "/users/:id", {
  headers: { "x-request-id": "req_1" },
  params: { id: "usr_1" },
  query: { includePosts: "true" },
});

const _createUser: Promise<{ id: string; name: string }> = functions.route(
  "POST",
  "/users",
  {
    body: { name: "Victor" },
  }
);
const _health: Promise<{ ok: boolean }> = functions.route("GET", "/health");
const _lookupUser: Promise<{ id: string; name: string }> = functions.invoke(
  "lookupUser",
  { id: "usr_1" }
);
const gateway = voke(functions, { config: { name: "api" } });
const _gatewayResponse: Response | Promise<Response> =
  gateway.request("/health");

// @ts-expect-error route params are inferred from the params schema input.
void functions.route("GET", "/users/:id", { params: { userId: "usr_1" } });

// @ts-expect-error route body is inferred from the body schema input.
void functions.route("POST", "/users", { body: { fullName: "Victor" } });

// @ts-expect-error functions.route takes plain header records, not Headers instances.
void functions.route("GET", "/plain", { headers: new Headers() });

// @ts-expect-error route-only functions are not accepted by functions.invoke.
void functions.invoke("users");

const _documentedRoute = app.get("/documented", {
  handler: () => ({ ok: true }),
  meta: {
    deprecated: false,
    description: "A documented route.",
    hidden: false,
    operationId: "getDocumented",
    summary: "Documented",
    tags: ["docs"],
  },
});
const _documentedMeta: RouteMeta | undefined = _documentedRoute.meta;

void app.get("/undocumented", {
  handler: () => ({ ok: true }),
  // @ts-expect-error meta accepts only the documented keys.
  meta: { title: "Unknown" },
});

// With an `output` schema the handler returns what that schema accepts, or a `Response`.
void app.get("/typed-output", {
  handler: () => Promise.resolve({ id: "usr_1" }),
  output: schema<{ id: string }>(),
});
void app.get("/typed-output/response", {
  handler: () => new Response(null, { status: 404 }),
  output: schema<{ id: string }>(),
});
void app.get("/typed-output/wrong", {
  // @ts-expect-error the handler result is checked against the output schema input.
  handler: () => ({ id: 1 }),
  output: schema<{ id: string }>(),
});

// A schema that accepts `unknown` and returns a typed value is read as declared.
const acceptAnything = createFunctions({
  skus: fn({
    routes: [
      app.post("/skus", {
        body: schema<unknown, { sku: string }>(),
        handler: (req) => ({ sku: req.body.sku }),
      }),
    ],
  }),
});
void acceptAnything.route("POST", "/skus", { body: { anything: 1 } });
