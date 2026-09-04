import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../platform/http/hono-env.js";
import {
  OPENAPI_TAGS,
  BEARER_AUTH_SECURITY,
} from "../../platform/openapi/document.js";
import {
  CategoryIdSchema,
  CategoryListResponseSchema,
  CategoryDtoSchema,
  CreateCategoryBodySchema,
  UpdateCategoryBodySchema,
} from "./categories.schemas.js";
import type { CategoryService } from "./categories.service.js";

const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
const categoryIdParams = z.object({ id: CategoryIdSchema });

const listRoute = createRoute({
  method: "get",
  path: "/categories",
  tags: [OPENAPI_TAGS.categories],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "Visible system and user categories",
      content: { "application/json": { schema: CategoryListResponseSchema } },
    },
  },
});

const createRouteDefinition = createRoute({
  method: "post",
  path: "/categories",
  tags: [OPENAPI_TAGS.categories],
  security: BEARER_AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: CreateCategoryBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Category created",
      content: {
        "application/json": {
          schema: z.object({
            category: CategoryDtoSchema,
          }),
        },
      },
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/categories/{id}",
  tags: [OPENAPI_TAGS.categories],
  security: BEARER_AUTH_SECURITY,
  request: {
    params: categoryIdParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateCategoryBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Category updated",
      content: {
        "application/json": {
          schema: z.object({
            category: CategoryDtoSchema,
          }),
        },
      },
    },
    404: {
      description: "Category not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const archiveRoute = createRoute({
  method: "delete",
  path: "/categories/{id}",
  tags: [OPENAPI_TAGS.categories],
  security: BEARER_AUTH_SECURITY,
  request: { params: categoryIdParams },
  responses: {
    200: {
      description: "Category archived",
      content: {
        "application/json": {
          schema: z.object({ archived: z.literal(true) }),
        },
      },
    },
    404: {
      description: "Category not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

/** Registers the protected category API and its OpenAPI operations. */
export function registerCategoriesRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: CategoryService,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) => {
    return c.json(
      { categories: await service.listCategories(c.get("userId")) },
      200,
    );
  });
  app.openapi({ ...createRouteDefinition, middleware: auth }, async (c) => {
    const category = await service.createCategory(
      c.get("userId"),
      c.req.valid("json"),
    );
    return c.json({ category }, 201);
  });
  app.openapi({ ...updateRoute, middleware: auth }, async (c) => {
    const category = await service.updateCategory(
      c.get("userId"),
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return c.json({ category }, 200);
  });
  app.openapi({ ...archiveRoute, middleware: auth }, async (c) => {
    await service.archiveCategory(c.get("userId"), c.req.valid("param").id);
    return c.json({ archived: true as const }, 200);
  });
}
