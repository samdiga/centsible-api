import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../../platform/http/hono-env.js";
import { validateOutput } from "../../platform/http/output-validation.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import {
  DashboardSummaryResponseSchema,
  ErrorEnvelopeSchema,
} from "./dashboard.schemas.js";
import type { DashboardService } from "./dashboard.service.js";

const summaryRoute = createRoute({
  method: "get",
  path: "/dashboard/summary",
  tags: [OPENAPI_TAGS.dashboard],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "Dashboard summary",
      content: {
        "application/json": { schema: DashboardSummaryResponseSchema },
      },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function registerDashboardRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: DashboardService,
): void {
  app.openapi({ ...summaryRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        DashboardSummaryResponseSchema,
        await service.getSummary(c.get("userId")),
      ),
      200,
    ),
  );
}
