import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../platform/http/hono-env.js";
import { validateOutput } from "../../platform/http/output-validation.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import type { RuleService } from "./rules.service.js";
import {
  ErrorEnvelopeSchema,
  RuleCreateResponseSchema,
  RuleDeleteResponseSchema,
  RuleIdSchema,
  RuleListResponseSchema,
  RulePreviewQuerySchema,
  RulePreviewResponseSchema,
  RuleUpdateResponseSchema,
  CreateRuleBodySchema,
  UpdateRuleBodySchema,
} from "./rules.schemas.js";

const idParams = z.object({ id: RuleIdSchema });
const listRoute = createRoute({
  method: "get",
  path: "/rules",
  tags: [OPENAPI_TAGS.rules],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "Rules",
      content: { "application/json": { schema: RuleListResponseSchema } },
    },
  },
});
const previewRoute = createRoute({
  method: "get",
  path: "/rules/preview",
  tags: [OPENAPI_TAGS.rules],
  security: BEARER_AUTH_SECURITY,
  request: { query: RulePreviewQuerySchema },
  responses: {
    200: {
      description: "Matching transaction count",
      content: { "application/json": { schema: RulePreviewResponseSchema } },
    },
  },
});
const createRouteDefinition = createRoute({
  method: "post",
  path: "/rules",
  tags: [OPENAPI_TAGS.rules],
  security: BEARER_AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateRuleBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Rule created",
      content: { "application/json": { schema: RuleCreateResponseSchema } },
    },
    503: {
      description: "Required retroactive service unavailable",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});
const updateRoute = createRoute({
  method: "patch",
  path: "/rules/{id}",
  tags: [OPENAPI_TAGS.rules],
  security: BEARER_AUTH_SECURITY,
  request: {
    params: idParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateRuleBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Rule updated",
      content: { "application/json": { schema: RuleUpdateResponseSchema } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/rules/{id}",
  tags: [OPENAPI_TAGS.rules],
  security: BEARER_AUTH_SECURITY,
  request: { params: idParams },
  responses: {
    200: {
      description: "Rule deleted",
      content: { "application/json": { schema: RuleDeleteResponseSchema } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function registerRulesRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: RuleService,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(RuleListResponseSchema, {
        rules: await service.listRules(c.get("userId")),
      }),
      200,
    ),
  );
  app.openapi({ ...previewRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(RulePreviewResponseSchema, {
        count: await service.previewCount(
          c.get("userId"),
          c.req.valid("query"),
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...createRouteDefinition, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        RuleCreateResponseSchema,
        await service.createRule(c.get("userId"), c.req.valid("json")),
      ),
      201,
    ),
  );
  app.openapi({ ...updateRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(RuleUpdateResponseSchema, {
        rule: await service.updateRule(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...deleteRoute, middleware: auth }, async (c) => {
    await service.deleteRule(c.get("userId"), c.req.valid("param").id);
    return c.json({ deleted: true as const }, 200);
  });
}
