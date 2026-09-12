import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../platform/http/hono-env.js";
import { OPENAPI_TAGS, BEARER_AUTH_SECURITY } from "../../platform/openapi/document.js";
import {
  TagIdSchema,
  TagListResponseSchema,
  TagDtoSchema,
  CreateTagBodySchema,
  UpdateTagBodySchema,
} from "./tags.schemas.js";
import type { TagService } from "./tags.service.js";

const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
const tagIdParams = z.object({ id: TagIdSchema });

const listRoute = createRoute({
  method: "get",
  path: "/tags",
  tags: [OPENAPI_TAGS.tags],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "The user's tags",
      content: { "application/json": { schema: TagListResponseSchema } },
    },
  },
});

const createRouteDefinition = createRoute({
  method: "post",
  path: "/tags",
  tags: [OPENAPI_TAGS.tags],
  security: BEARER_AUTH_SECURITY,
  request: {
    body: { required: true, content: { "application/json": { schema: CreateTagBodySchema } } },
  },
  responses: {
    201: {
      description: "Tag created",
      content: { "application/json": { schema: z.object({ tag: TagDtoSchema }) } },
    },
    409: {
      description: "A tag with this name already exists",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/tags/{id}",
  tags: [OPENAPI_TAGS.tags],
  security: BEARER_AUTH_SECURITY,
  request: {
    params: tagIdParams,
    body: { required: true, content: { "application/json": { schema: UpdateTagBodySchema } } },
  },
  responses: {
    200: {
      description: "Tag updated",
      content: { "application/json": { schema: z.object({ tag: TagDtoSchema }) } },
    },
    404: {
      description: "Tag not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    409: {
      description: "A tag with this name already exists",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/tags/{id}",
  tags: [OPENAPI_TAGS.tags],
  security: BEARER_AUTH_SECURITY,
  request: { params: tagIdParams },
  responses: {
    200: {
      description: "Tag deleted",
      content: { "application/json": { schema: z.object({ deleted: z.literal(true) }) } },
    },
    404: {
      description: "Tag not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

/** Registers the protected tags API and its OpenAPI operations. */
export function registerTagsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: TagService,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) => {
    return c.json({ tags: await service.listTags(c.get("userId")) }, 200);
  });
  app.openapi({ ...createRouteDefinition, middleware: auth }, async (c) => {
    const tag = await service.createTag(c.get("userId"), c.req.valid("json"));
    return c.json({ tag }, 201);
  });
  app.openapi({ ...updateRoute, middleware: auth }, async (c) => {
    const tag = await service.updateTag(
      c.get("userId"),
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return c.json({ tag }, 200);
  });
  app.openapi({ ...deleteRoute, middleware: auth }, async (c) => {
    await service.deleteTag(c.get("userId"), c.req.valid("param").id);
    return c.json({ deleted: true as const }, 200);
  });
}
