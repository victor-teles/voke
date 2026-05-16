import { api, createApiApp, json } from "voke";

import config from "../voke.config";
import { requestInfo } from "./middleware/request-info";
import { healthRoutes } from "./routes/health";
import { usersRoutes } from "./routes/users";

const app = createApiApp({
  config,
  middleware: [requestInfo],
  routes: [usersRoutes],
});

app.get("/", (c) => c.json({ data: { message: "Hello from Voke" } }));
app.route("/health", healthRoutes);
app.get("/typed", () =>
  json<{ message: string }>({ message: "Typed route response" })
);

const helloApi = api(app, { config });

export const { handler } = helloApi;
export default helloApi;
