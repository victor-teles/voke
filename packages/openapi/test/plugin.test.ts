import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schema } from "@vokejs/schema";
import {
  createFunctions,
  createVokeModel,
  defineConfig,
  http,
  projectFunctionEntries,
  route,
  voke,
} from "voke";
import type { VokeConfigInput, VokePlugin } from "voke";

import { openapi } from "../src/index";
import type { OpenApiDocument, OpenApiOptions } from "../src/index";
import { scalarVersion } from "../src/scalar";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

const functions = () =>
  createFunctions({
    users: http({
      routes: [
        route.get("/users/:id", {
          handler: (request) => ({ id: request.params.id }),
          meta: { summary: "Get a user" },
          params: schema.object({ id: schema.string() }),
        }),
        route.post("/users", {
          body: schema.object({ name: schema.string() }),
          handler: (request) => ({ id: "usr_1", name: request.body.name }),
        }),
      ],
    }),
  });

// `voke dev` sets VOKE_DEV_SUMMARY=1; the Gateway then also prints the Dev Function Summary.
const withDev = <TResult>(run: () => TResult): TResult => {
  const previous = process.env.VOKE_DEV_SUMMARY;
  const info = spyOn(console, "info").mockImplementation(() => {});
  process.env.VOKE_DEV_SUMMARY = "1";

  try {
    return run();
  } finally {
    info.mockRestore();

    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "VOKE_DEV_SUMMARY");
    } else {
      process.env.VOKE_DEV_SUMMARY = previous;
    }
  }
};

const gatewayWith = (options?: OpenApiOptions) =>
  voke(functions(), {
    config: { name: "users-api", plugins: [openapi(options)] },
  });

const fetchDocument = async (
  gateway: ReturnType<typeof gatewayWith>,
  url = "http://localhost/openapi.json"
): Promise<{ document: OpenApiDocument; response: Response }> => {
  const response = await gateway.request(url);

  return {
    document: (await response.clone().json()) as OpenApiDocument,
    response,
  };
};

const statusOf = async (
  gateway: ReturnType<typeof gatewayWith>,
  path: string
): Promise<number> => {
  const response = await gateway.request(path);

  return response.status;
};

const pageOf = async (
  gateway: ReturnType<typeof gatewayWith>,
  path: string
): Promise<string> => {
  const response = await gateway.request(path);

  return await response.text();
};

test("with expose: true the Gateway serves the document and the Scalar page", async () => {
  const gateway = gatewayWith({ expose: true, title: "Users API" });
  const { document, response } = await fetchDocument(gateway);
  const page = await gateway.request("/docs");
  const html = await page.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("application/json");
  expect(document.openapi).toBe("3.1.0");
  expect(document.info.title).toBe("Users API");
  expect(Object.keys(document.paths)).toEqual(["/users/{id}", "/users"]);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(html).toContain(
    `<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${scalarVersion}"></script>`
  );
  expect(html).toContain(
    'Scalar.createApiReference("#app", {"url":"/openapi.json"})'
  );
  expect(html).toContain("<title>Users API</title>");
});

test("the served document lists the request origin as its server unless servers are configured", async () => {
  const exposed = await fetchDocument(
    gatewayWith({ expose: true }),
    "https://api.example.com/openapi.json"
  );
  const configured = await fetchDocument(
    gatewayWith({ expose: true, servers: ["https://orders.example.com"] }),
    "https://api.example.com/openapi.json"
  );

  expect(exposed.document.servers).toEqual([
    { url: "https://api.example.com" },
  ]);
  expect(configured.document.servers).toEqual([
    { url: "https://orders.example.com" },
  ]);
});

test("without expose and outside voke dev, nothing is served", async () => {
  const gateway = gatewayWith();

  expect(await statusOf(gateway, "/openapi.json")).toBe(404);
  expect(await statusOf(gateway, "/docs")).toBe(404);
});

test("under voke dev the document and the page are served without expose", async () => {
  const gateway = withDev(() => gatewayWith({ uiPath: "/reference" }));
  const { document, response } = await fetchDocument(gateway);
  const page = await gateway.request("/reference");

  expect(response.status).toBe(200);
  expect(Object.keys(document.paths)).toEqual(["/users/{id}", "/users"]);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Scalar.createApiReference");
  expect(await statusOf(gateway, "/users/usr_1")).toBe(200);
});

test("uiPath: false serves the document only", async () => {
  const gateway = gatewayWith({ expose: true, uiPath: false });

  expect(await statusOf(gateway, "/openapi.json")).toBe(200);
  expect(await statusOf(gateway, "/docs")).toBe(404);
});

test("expose: true contributes the public Function openapi-docs, which deploys", () => {
  const model = createVokeModel({
    functions: functions(),
    name: "users-api",
    plugins: [openapi({ expose: true })],
    stage: "dev",
  });

  expect(model.apis.http?.routes).toContainEqual({
    function: "openapi-docs",
    route: "GET /openapi.json",
  });
  expect(model.apis.http?.routes).toContainEqual({
    function: "openapi-docs",
    route: "GET /docs",
  });
  expect(model.functions["openapi-docs"]).toBeDefined();

  const [, docs] =
    projectFunctionEntries(functions(), {
      plugins: [openapi({ expose: true })],
    }).find(([key]) => key === "openapi-docs") ?? [];

  expect(docs?.routes?.map((docsRoute) => docsRoute.authorizer)).toEqual([
    "none",
    "none",
  ]);
});

test("without expose the Plugin contributes no Function, so nothing deploys", () => {
  const model = createVokeModel({
    functions: functions(),
    name: "users-api",
    plugins: [openapi()],
    stage: "dev",
  });

  expect(model.functions["openapi-docs"]).toBeUndefined();
});

test("the exposed handlers fail clearly when the Plugin was never set up", async () => {
  const plugin = openapi({ expose: true });
  const docs = plugin.contributions?.functions?.docs;
  // Served by a Gateway composed without the Plugin in its config.
  const gateway = voke(
    createFunctions({ docs: docs ?? http({ routes: [] }) }),
    {
      config: { name: "detached" },
    }
  );
  const error = spyOn(console, "error").mockImplementation(() => {});

  try {
    const response = await gateway.request("/openapi.json");

    expect(response.status).toBe(500);
  } finally {
    error.mockRestore();
  }
});

test("invalid paths and Scalar versions are config errors", () => {
  expect(() => openapi({ documentPath: "openapi.json" })).toThrow(
    "plugins.openapi.documentPath"
  );
  expect(() => openapi({ documentPath: "/docs" })).toThrow(
    "plugins.openapi.uiPath"
  );
  expect(() => openapi({ uiPath: "/users/:id" })).toThrow(
    "plugins.openapi.uiPath"
  );
  expect(() =>
    openapi({ scalar: { version: '1.0.0"><script>alert(1)</script>' } })
  ).toThrow("plugins.openapi.scalar.version");
});

test("the page escapes the title and pins the configured Scalar version", async () => {
  const gateway = gatewayWith({
    expose: true,
    scalar: { version: "1.70.0" },
    title: "</title><script>alert(1)</script>",
  });
  const html = await pageOf(gateway, "/docs");

  expect(html).toContain("@scalar/api-reference@1.70.0");
  expect(html).toContain(
    "<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>"
  );
  expect(html).not.toContain("<script>alert(1)");
});

const runGenerate = async (
  plugin: VokePlugin,
  flags: Record<string, string>,
  cwd: string
): Promise<string[]> => {
  const lines: string[] = [];
  const config = defineConfig({
    name: "users-api",
    plugins: [plugin],
  } satisfies VokeConfigInput);

  await plugin.cli?.commands.generate?.run({
    config,
    cwd,
    flags,
    loadFunctions: async () =>
      await Promise.resolve(projectFunctionEntries(functions(), config)),
    output: (line) => lines.push(line),
    positional: [],
  });

  return lines;
};

test("openapi generate writes the document with two-space JSON and a trailing newline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "voke-openapi-"));
  temporaryDirectories.push(cwd);
  const lines = await runGenerate(
    openapi({ expose: true }),
    { out: "build/openapi.json", server: "https://api.example.com" },
    cwd
  );
  const text = await readFile(join(cwd, "build/openapi.json"), "utf-8");
  const document = JSON.parse(text) as OpenApiDocument;

  expect(lines).toEqual(["Wrote build/openapi.json (2 operations)"]);
  expect(text).toBe(`${JSON.stringify(document, null, 2)}\n`);
  expect(document.servers).toEqual([{ url: "https://api.example.com" }]);
  // The Plugin's own Function is not part of the API it describes.
  expect(Object.keys(document.paths)).toEqual(["/users/{id}", "/users"]);
});

test("openapi generate writes openapi.json in the working directory by default", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "voke-openapi-"));
  temporaryDirectories.push(cwd);
  const lines = await runGenerate(openapi(), {}, cwd);
  const document = JSON.parse(
    await readFile(join(cwd, "openapi.json"), "utf-8")
  ) as OpenApiDocument;

  expect(lines).toEqual(["Wrote openapi.json (2 operations)"]);
  expect(document).not.toHaveProperty("servers");
});
