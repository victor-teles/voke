import { createFunctions, http, route, voke } from "voke";
import { created, error } from "voke/response";
import { schema } from "voke/schema";

import config from "../voke.config";
import { requestInfo } from "./middleware/request-info";

interface User {
  id: string;
  name: string;
}

const users = new Map<string, User>([
  ["usr_1", { id: "usr_1", name: "Victor" }],
]);

const userParams = schema.object({
  id: schema.string(),
});

const createUserBody = schema.object({
  name: schema.string(),
});

const functions = createFunctions({
  http: http({
    routes: [
      route.get("/", {
        handler: () => ({ message: "Hello from Voke" }),
      }),
      route.get("/health", {
        handler: () => ({
          ok: true,
          service: config.name,
          stage: config.stage,
        }),
      }),
      route.get("/typed", {
        handler: () => ({ message: "Typed route response" }),
      }),
      route.get("/users", {
        handler: () => [...users.values()],
      }),
      route.get("/users/:id", {
        handler: (req) => {
          const user = users.get(req.params.id);

          if (user === undefined) {
            return error("User not found", {
              code: "USER_NOT_FOUND",
              status: 404,
            });
          }

          return user;
        },
        params: userParams,
      }),
      route.post("/users", {
        body: createUserBody,
        handler: (req) => {
          const name = req.body.name.trim();

          if (name.length === 0) {
            return error("User name is required", {
              code: "USER_NAME_REQUIRED",
              status: 400,
            });
          }

          const user = {
            id: `usr_${users.size + 1}`,
            name,
          };

          users.set(user.id, user);

          return created(user);
        },
      }),
    ],
  }),
});

const gateway = voke(functions, {
  config,
  middleware: [requestInfo],
});

export default gateway;
