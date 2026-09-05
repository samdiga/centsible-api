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
  ForecastAccuracyResponseSchema,
  ForecastQuerySchema,
  ForecastResponseSchema,
} from "./forecast.schemas.js";
import { toForecastResponse } from "./forecast.mapper.js";
import type { ForecastService } from "./forecast.service.js";

const forecastRoute = createRoute({
  method: "get",
  path: "/forecast",
  tags: [OPENAPI_TAGS.forecast],
  security: BEARER_AUTH_SECURITY,
  request: { query: ForecastQuerySchema },
  responses: {
    200: {
      description: "Cash horizon forecast",
      content: { "application/json": { schema: ForecastResponseSchema } },
    },
    400: {
      description: "Invalid forecast query",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    403: {
      description: "Forecast feature is disabled",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const accuracyRoute = createRoute({
  method: "get",
  path: "/forecast/accuracy",
  tags: [OPENAPI_TAGS.forecast],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "Forecast accuracy",
      content: {
        "application/json": { schema: ForecastAccuracyResponseSchema },
      },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

/** Registers both Forecast reads at their compatibility paths. */
export function registerForecastRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: ForecastService,
): void {
  app.openapi({ ...forecastRoute, middleware: auth }, async (c) => {
    const query = c.req.valid("query");
    return c.json(
      validateOutput(
        ForecastResponseSchema,
        toForecastResponse(
          await service.getForecast(c.get("userId"), query.horizonDays),
          query.horizonDays,
        ),
      ),
      200,
    );
  });
  app.openapi({ ...accuracyRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        ForecastAccuracyResponseSchema,
        await service.getAccuracy(c.get("userId")),
      ),
      200,
    ),
  );
}
