import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../platform/http/hono-env.js";

/** Registers the process-independent health endpoint. */
export function registerHealthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "centsible-api",
      timestamp: new Date().toISOString(),
    }),
  );
}
