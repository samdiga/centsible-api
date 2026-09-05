import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../platform/http/hono-env.js";
import { validateOutput } from "../../platform/http/output-validation.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import {
  BudgetActiveResponseSchema,
  BudgetCreateResponseSchema,
  BudgetDeletedResponseSchema,
  BudgetItemResponseSchema,
  BudgetProgressResponseSchema,
  BudgetSuggestionsResponseSchema,
  BudgetUpdatedResponseSchema,
  CreateBudgetBodySchema,
  ErrorEnvelopeSchema,
  ReplaceBudgetItemsBodySchema,
  UpsertBudgetItemBodySchema,
} from "./budgets.schemas.js";
import type { BudgetsService } from "./budgets.service.js";

const idParams = z.object({ id: z.string().uuid() });
const categoryParams = z.object({ categoryId: z.string().uuid() });
const options = {
  tags: [OPENAPI_TAGS.budgets],
  security: BEARER_AUTH_SECURITY,
};
const notFound = {
  404: {
    description: "Budget not found",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
};

const suggestionsRoute = createRoute({
  method: "get",
  path: "/budgets/suggestions",
  ...options,
  responses: {
    200: {
      description: "Budget setup suggestions",
      content: {
        "application/json": { schema: BudgetSuggestionsResponseSchema },
      },
    },
  },
});
const activeRoute = createRoute({
  method: "get",
  path: "/budgets/active",
  ...options,
  responses: {
    200: {
      description: "Active budget",
      content: { "application/json": { schema: BudgetActiveResponseSchema } },
    },
    ...notFound,
  },
});
const createRouteDefinition = createRoute({
  method: "post",
  path: "/budgets",
  ...options,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateBudgetBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Budget created",
      content: { "application/json": { schema: BudgetCreateResponseSchema } },
    },
  },
});
const progressRoute = createRoute({
  method: "get",
  path: "/budgets/{id}/progress",
  ...options,
  request: { params: idParams },
  responses: {
    200: {
      description: "Budget progress",
      content: { "application/json": { schema: BudgetProgressResponseSchema } },
    },
    ...notFound,
  },
});
const replaceRoute = createRoute({
  method: "put",
  path: "/budgets/{id}/items",
  ...options,
  request: {
    params: idParams,
    body: {
      required: true,
      content: { "application/json": { schema: ReplaceBudgetItemsBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Budget items replaced",
      content: { "application/json": { schema: BudgetUpdatedResponseSchema } },
    },
    ...notFound,
  },
});
const upsertRoute = createRoute({
  method: "patch",
  path: "/budgets/active/items/{categoryId}",
  ...options,
  request: {
    params: categoryParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpsertBudgetItemBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Budget item updated",
      content: { "application/json": { schema: BudgetItemResponseSchema } },
    },
    ...notFound,
  },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/budgets/active/items/{categoryId}",
  ...options,
  request: { params: categoryParams },
  responses: {
    200: {
      description: "Budget item deleted",
      content: { "application/json": { schema: BudgetDeletedResponseSchema } },
    },
    ...notFound,
  },
});

export function registerBudgetsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: BudgetsService,
): void {
  app.openapi({ ...suggestionsRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(BudgetSuggestionsResponseSchema, {
        suggestions: await service.getSetupSuggestions(c.get("userId")),
      }),
      200,
    ),
  );
  app.openapi({ ...activeRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(BudgetActiveResponseSchema, {
        budget: await service.getActiveBudget(c.get("userId")),
      }),
      200,
    ),
  );
  app.openapi({ ...createRouteDefinition, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        BudgetCreateResponseSchema,
        await service.createBudget(c.get("userId"), c.req.valid("json")),
      ),
      201,
    ),
  );
  app.openapi({ ...progressRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(BudgetProgressResponseSchema, {
        progress: await service.getBudgetProgress(
          c.get("userId"),
          c.req.valid("param").id,
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...replaceRoute, middleware: auth }, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await service.replaceBudgetItems(
      c.get("userId"),
      id,
      body.items.map((item) => ({
        categoryId: item.categoryId,
        amountCents: BigInt(item.amountCents),
      })),
    );
    return c.json(
      validateOutput(BudgetUpdatedResponseSchema, { updated: true }),
      200,
    );
  });
  app.openapi({ ...upsertRoute, middleware: auth }, async (c) => {
    const item = await service.upsertBudgetItem(
      c.get("userId"),
      c.req.valid("param").categoryId,
      BigInt(c.req.valid("json").amountCents),
    );
    return c.json(validateOutput(BudgetItemResponseSchema, { item }), 200);
  });
  app.openapi({ ...deleteRoute, middleware: auth }, async (c) => {
    const deleted = await service.deleteBudgetItem(
      c.get("userId"),
      c.req.valid("param").categoryId,
    );
    return c.json(
      validateOutput(BudgetDeletedResponseSchema, { deleted }),
      200,
    );
  });
}
