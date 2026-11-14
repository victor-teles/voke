import { expect, test } from "bun:test";

import { createFunctions, fn, http, route, VokeModelError } from "voke";
import type { StandardSchemaV1 } from "voke";

import { dynamodbTable, synthesizeCloudFormation } from "../src/cloudformation";

const text: StandardSchemaV1<string, string> = {
  "~standard": {
    validate: (value) => ({ data: value as string, success: true }),
    vendor: "voke-test",
    version: 1,
  },
};

const routesOf = (template: ReturnType<typeof synthesizeCloudFormation>) =>
  Object.fromEntries(
    Object.entries(template.Resources)
      .filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route")
      .map(([id, resource]) => [id, resource.Properties.RouteKey])
  );

const synthesizeWith = (order: "a" | "b") => {
  const users = route.get("/users/:id", { handler: () => "user" });
  const files = route.get("/files/*", { handler: () => "file" });
  const http_ = http({
    routes: order === "a" ? [users, files] : [files, users],
  });
  const admin = http({
    routes: [route.post("/admin", { handler: () => "ok" })],
  });
  const report = fn({ handler: () => "done", output: text });

  return synthesizeCloudFormation({
    functions: createFunctions(
      order === "a"
        ? { admin, http: http_, report }
        : { admin, http: http_, report }
    ),
    name: "routes",
  });
};

test("writes API Gateway route keys with {param} and {proxy+}", () => {
  expect(Object.values(routesOf(synthesizeWith("a"))).toSorted()).toEqual([
    "GET /files/{proxy+}",
    "GET /users/{id}",
    "POST /admin",
  ]);
});

test("keeps every logical id when routes or Functions are reordered", () => {
  const first = synthesizeWith("a");
  const second = synthesizeWith("b");

  expect(Object.keys(second.Resources).toSorted()).toEqual(
    Object.keys(first.Resources).toSorted()
  );
  expect(routesOf(second)).toEqual(routesOf(first));
  // The Function keyed "http" owns the bare ids, whatever its position.
  expect(first.Resources.Function?.Metadata?.VokeFunction).toBe("http");
});

test("creates one integration per Function and points every route at it", () => {
  const template = synthesizeWith("a");
  const integrations = Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === "AWS::ApiGatewayV2::Integration"
  );

  expect(integrations.map(([id]) => id).toSorted()).toEqual([
    "AdminIntegration",
    "HttpIntegration",
  ]);
  expect(template.Resources.HttpGETUsersByIdRoute?.Properties.Target).toEqual({
    "Fn::Sub": `integrations/\${HttpIntegration}`,
  });
  expect(template.Resources.HttpGETFilesProxyRoute?.Properties.Target).toEqual({
    "Fn::Sub": `integrations/\${HttpIntegration}`,
  });
});

const synthesizeRoute = (path: string) =>
  synthesizeCloudFormation({
    functions: createFunctions({
      http: http({
        routes: [route.get(path as "/", { handler: () => "x" })],
      }),
    }),
    name: "bad-routes",
  });

test("rejects route forms API Gateway cannot express", () => {
  expect(() => synthesizeRoute("/files/:name{[a-z]+}")).toThrow(VokeModelError);
  expect(() => synthesizeRoute("/users/:id?")).toThrow(
    "has no API Gateway equivalent"
  );
  expect(() => synthesizeRoute("/a/*/b")).toThrow(
    'has a "*" before the last path segment'
  );
});

test("a config without Functions synthesizes only its resources", () => {
  const template = synthesizeCloudFormation({
    name: "resources-only",
    resources: { ordersTable: dynamodbTable() },
  });

  expect(
    Object.values(template.Resources).map((resource) => resource.Type)
  ).toEqual(["AWS::DynamoDB::Table"]);
  expect(Object.keys(template.Outputs)).toEqual(["OrdersTableName"]);
});
