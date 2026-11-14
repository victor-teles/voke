import { schema } from "@voke/schema";
import { createFunctions, http, route, voke } from "voke";

import config from "./voke.config";

const functions = createFunctions({
  http: http({
    routes: [
      route.post("/users", {
        body: schema.object({ name: schema.string().min(1) }),
        handler: (request) => ({ greeting: `Hello, ${request.body.name}` }),
      }),
    ],
  }),
});

export default voke(functions, { config });
