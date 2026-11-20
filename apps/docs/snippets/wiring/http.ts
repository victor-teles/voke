import { schema } from "@vokejs/schema";
import { http, route } from "voke";

export const users = http({
  routes: [
    route.get("/users/:id", {
      handler: (request) => ({ id: request.params.id }),
      params: schema.object({ id: schema.string() }),
    }),
  ],
});
