import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../../platform/http/hono-env.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import {
  BackupPayloadSchema,
  ErrorEnvelopeSchema,
  UserDataActionResponseSchema,
} from "./user-data.schemas.js";
import type { UserDataService } from "./user-data.service.js";

const exportRoute = createRoute({
  method: "get",
  path: "/user/export",
  tags: [OPENAPI_TAGS.userData],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "Portable user data backup",
      content: { "application/json": { schema: BackupPayloadSchema } },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const importRoute = createRoute({
  method: "post",
  path: "/user/import",
  tags: [OPENAPI_TAGS.userData],
  security: BEARER_AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: BackupPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "User data imported",
      content: { "application/json": { schema: UserDataActionResponseSchema } },
    },
    400: {
      description: "Invalid backup",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    503: {
      description: "Required service unavailable",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const resetRoute = createRoute({
  method: "delete",
  path: "/user/data",
  tags: [OPENAPI_TAGS.userData],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "User data deleted",
      content: { "application/json": { schema: UserDataActionResponseSchema } },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    503: {
      description: "Required service unavailable",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

/** Registers the protected user backup and reset endpoints. */
export function registerUserDataRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: UserDataService,
): void {
  app.openapi({ ...exportRoute, middleware: auth }, async (c) => {
    const stream = await service.exportUserData(c.get("userId"));
    return c.body(stream, 200, {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    }) as never;
  });
  app.openapi({ ...importRoute, middleware: auth }, async (c) => {
    await service.importUserData(c.get("userId"), c.req.valid("json"));
    return c.json({ ok: true as const }, 200);
  });
  app.openapi({ ...resetRoute, middleware: auth }, async (c) => {
    await service.resetUserData(c.get("userId"));
    return c.json({ ok: true as const }, 200);
  });
}

export const registerUserRoutes = registerUserDataRoutes;
