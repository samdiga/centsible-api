import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppEnv } from "../../platform/http/hono-env.js";
import { OPENAPI_TAGS } from "../../platform/openapi/document.js";

const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("centsible-api"),
  timestamp: z.iso.datetime(),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: [OPENAPI_TAGS.health],
  responses: {
    200: {
      description: "Service health",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

/** Registers the process-independent health endpoint. */
export function registerHealthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(healthRoute, (c) =>
    c.json({
      status: "ok" as const,
      service: "centsible-api" as const,
      timestamp: new Date().toISOString(),
    }),
  );
}
