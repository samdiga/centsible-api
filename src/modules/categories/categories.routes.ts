import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../platform/http/hono-env.js";
import {
  OPENAPI_TAGS,
  BEARER_AUTH_SECURITY,
} from "../../platform/openapi/document.js";
import {
  ArchiveCategoryQuerySchema,
  ArchiveCategoryResponseSchema,
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
      description:
        "Category updated. Editing a shared default returns the user's own copy (a new id).",
      content: {
        "application/json": {
          schema: z.object({
            category: CategoryDtoSchema,
          }),
        },
      },
    },
    400: {
      description: "Invalid move (two levels only)",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    404: {
      description: "Category not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    409: {
      description: "Another category already has this name there",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

const archiveRoute = createRoute({
  method: "delete",
  path: "/categories/{id}",
  tags: [OPENAPI_TAGS.categories],
  security: BEARER_AUTH_SECURITY,
  request: { params: categoryIdParams, query: ArchiveCategoryQuerySchema },
  responses: {
    200: {
      description:
        "Category archived; its transactions, plan items, rules, bills and goals moved to `reassignTo` (default: its parent, or uncategorised for a group). Its subcategories become top-level groups.",
      content: {
        "application/json": { schema: ArchiveCategoryResponseSchema },
      },
    },
    400: {
      description: "Invalid reassignment target",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    409: {
      description: "A subcategory's name clashes with an existing group",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
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
    const result = await service.archiveCategory(
      c.get("userId"),
      c.req.valid("param").id,
      c.req.valid("query"),
    );
    return c.json({ archived: true as const, ...result }, 200);
  });
}
