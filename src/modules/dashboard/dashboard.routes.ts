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
  NetWorthHistoryQuerySchema,
  NetWorthHistoryResponseSchema,
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

const historyRoute = createRoute({
  method: "get",
  path: "/dashboard/net-worth/history",
  tags: [OPENAPI_TAGS.dashboard],
  security: BEARER_AUTH_SECURITY,
  request: { query: NetWorthHistoryQuerySchema },
  responses: {
    200: {
      description: "Net worth history at the requested resolution",
      content: {
        "application/json": { schema: NetWorthHistoryResponseSchema },
      },
    },
    400: {
      description: "Invalid net worth history query",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
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
  app.openapi({ ...historyRoute, middleware: auth }, async (c) => {
    const { dateFrom, dateTo, resolution } = c.req.valid("query");
    return c.json(
      validateOutput(
        NetWorthHistoryResponseSchema,
        await service.getNetWorthHistory(
          c.get("userId"),
          dateFrom,
          dateTo,
          resolution,
        ),
      ),
      200,
    );
  });
}
