import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../platform/http/hono-env.js";
import { NotFoundError } from "../../platform/errors/app-error.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import {
  AccountIdSchema,
  AccountListResponseSchema,
  DeleteAccountResponseSchema,
  ErrorEnvelopeSchema,
  RefreshAccountResponseSchema,
} from "./accounts.schemas.js";
import type { AccountService } from "./accounts.service.js";

const accountParams = z.object({ accountId: AccountIdSchema });
const listRoute = createRoute({
  method: "get",
  path: "/accounts",
  tags: [OPENAPI_TAGS.accounts],
  security: BEARER_AUTH_SECURITY,
  responses: {
    200: {
      description: "Account summaries",
      content: { "application/json": { schema: AccountListResponseSchema } },
    },
  },
});
const refreshRoute = createRoute({
  method: "post",
  path: "/accounts/{accountId}/refresh-balance",
  tags: [OPENAPI_TAGS.accounts],
  security: BEARER_AUTH_SECURITY,
  request: { params: accountParams },
  responses: {
    200: {
      description: "Refreshed account balance",
      content: { "application/json": { schema: RefreshAccountResponseSchema } },
    },
    404: {
      description: "Account not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    502: {
      description: "Upstream unavailable",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    429: {
      description: "Refresh rate limited",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/accounts/{accountId}",
  tags: [OPENAPI_TAGS.accounts],
  security: BEARER_AUTH_SECURITY,
  request: { params: accountParams },
  responses: {
    200: {
      description: "Account removed",
      content: { "application/json": { schema: DeleteAccountResponseSchema } },
    },
    404: {
      description: "Account not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function registerAccountsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: AccountService,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) =>
    c.json(
      { accounts: await service.listAccountSummaries(c.get("userId")) },
      200,
    ),
  );
  app.openapi({ ...refreshRoute, middleware: auth }, async (c) =>
    c.json(
      {
        account: await service.refreshAccountBalance(
          c.get("userId"),
          c.req.valid("param").accountId,
        ),
      },
      200,
    ),
  );
  app.openapi({ ...deleteRoute, middleware: auth }, async (c) => {
    const result = await service.removeAccount(
      c.get("userId"),
      c.req.valid("param").accountId,
    );
    if (!result.removed) throw new NotFoundError("account");
    return c.json(
      { ok: true as const, unlinkedItem: result.unlinkedItem },
      200,
    );
  });
}
