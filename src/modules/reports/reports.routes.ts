import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../../platform/http/hono-env.js";
import { validateOutput } from "../../platform/http/output-validation.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import {
  ErrorEnvelopeSchema,
  ReportQuerySchema,
  ReportSummaryResponseSchema,
} from "./reports.schemas.js";
import type { ReportsService } from "./reports.service.js";

const summaryRoute = createRoute({
  method: "get",
  path: "/reports/summary",
  tags: [OPENAPI_TAGS.reports],
  security: BEARER_AUTH_SECURITY,
  request: { query: ReportQuerySchema },
  responses: {
    200: {
      description: "Report summary",
      content: {
        "application/json": { schema: ReportSummaryResponseSchema },
      },
    },
    400: {
      description: "Invalid report query",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function registerReportsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: ReportsService,
): void {
  app.openapi({ ...summaryRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        ReportSummaryResponseSchema,
        await service.getReport(c.get("userId"), c.req.valid("query")),
      ),
      200,
    ),
  );
}
