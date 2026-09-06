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
  NotificationPreferencesResponseSchema,
  UpdateNotificationPreferencesSchema,
} from "./notifications.schemas.js";
import type { NotificationPreferencesService } from "./notifications.service.js";

const preferencesRoute = createRoute({
  method: "get",
  path: "/notifications/preferences",
  tags: [OPENAPI_TAGS.notifications],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "Notification preferences",
      content: {
        "application/json": { schema: NotificationPreferencesResponseSchema },
      },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const updatePreferencesRoute = createRoute({
  method: "patch",
  path: "/notifications/preferences",
  tags: [OPENAPI_TAGS.notifications],
  security: BEARER_AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: UpdateNotificationPreferencesSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Notification preferences updated",
      content: {
        "application/json": { schema: NotificationPreferencesResponseSchema },
      },
    },
    400: {
      description: "Invalid notification preferences",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function registerNotificationsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: NotificationPreferencesService,
): void {
  app.openapi({ ...preferencesRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(NotificationPreferencesResponseSchema, {
        preferences: await service.getPreferences(c.get("userId")),
      }),
      200,
    ),
  );
  app.openapi({ ...updatePreferencesRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(NotificationPreferencesResponseSchema, {
        preferences: await service.updatePreferences(
          c.get("userId"),
          c.req.valid("json"),
        ),
      }),
      200,
    ),
  );
}

export const registerNotificationRoutes = registerNotificationsRoutes;
