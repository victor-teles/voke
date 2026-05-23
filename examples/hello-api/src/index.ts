import {
  api,
  createGateway,
  defineFunction,
  defineFunctions,
  jsonError,
  Voke,
} from "voke";
import type { StandardSchemaV1 } from "voke";

import config from "../voke.config";
import { requestInfo } from "./middleware/request-info";

interface User {
  id: string;
  name: string;
}

const users = new Map<string, User>([
  ["usr_1", { id: "usr_1", name: "Victor" }],
]);

const schema = <TInput, TOutput = TInput>(
  validate: (value: TInput) => TOutput
): StandardSchemaV1<TInput, TOutput> => ({
  "~standard": {
    validate: (value) => ({ data: validate(value), success: true }),
    vendor: "voke-example",
    version: 1,
  },
});

const userParams = schema<{ id: string }>((params) => params);
const createUserBody = schema<unknown, { name: string }>((value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return { name: value.name.trim() };
  }

  return { name: "" };
});

const app = new Voke();

const functions = defineFunctions({
  routes: defineFunction({
    routes: [
      app.get("/", {
        handler: () => ({ message: "Hello from Voke" }),
      }),
      app.get("/health", {
        handler: () => ({
          ok: true,
          service: config.name,
          stage: config.stage,
        }),
      }),
      app.get("/typed", {
        handler: () => ({ message: "Typed route response" }),
      }),
      app.get("/users", {
        handler: () => [...users.values()],
      }),
      app.get("/users/:id", {
        handler: (req) => {
          const user = users.get(req.params.id);

          if (user === undefined) {
            return jsonError("User not found", {
              code: "USER_NOT_FOUND",
              status: 404,
            });
          }

          return user;
        },
        params: userParams,
      }),
      app.post("/users", {
        body: createUserBody,
        handler: (req) => {
          if (req.body.name.length === 0) {
            return jsonError("User name is required", {
              code: "USER_NAME_REQUIRED",
              status: 400,
            });
          }

          const user = {
            id: `usr_${users.size + 1}`,
            name: req.body.name,
          };

          users.set(user.id, user);

          return Response.json({ data: user }, { status: 201 });
        },
      }),
    ],
  }),
});

const gateway = createGateway({
  config: { ...config, functions },
  middleware: [requestInfo],
});

export default api(gateway, { config });
