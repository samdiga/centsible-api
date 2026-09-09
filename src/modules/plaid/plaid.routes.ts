import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../platform/http/hono-env.js";
import { validateOutput } from "../../platform/http/output-validation.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import type { PlaidService } from "./plaid.service.js";
import {
  DeletePlaidItemResponseSchema,
  ExchangePublicTokenBodySchema,
  ExchangePublicTokenResponseSchema,
  LinkTokenResponseSchema,
  PlaidErrorEnvelopeSchema,
  PlaidItemIdSchema,
  PlaidItemsResponseSchema,
  RefreshItemBalancesResponseSchema,
} from "./plaid.schemas.js";

const params = z.object({ itemId: PlaidItemIdSchema });
const options = {
  tags: [OPENAPI_TAGS.plaid],
  security: BEARER_AUTH_SECURITY,
};
const errors = {
  404: {
    description: "Plaid item not found",
    content: { "application/json": { schema: PlaidErrorEnvelopeSchema } },
  },
  502: {
    description: "Plaid unavailable",
    content: { "application/json": { schema: PlaidErrorEnvelopeSchema } },
  },
} as const;

const listRoute = createRoute({
  method: "get",
  path: "/plaid/items",
  ...options,
  responses: {
    200: {
      description: "Linked Plaid items",
      content: { "application/json": { schema: PlaidItemsResponseSchema } },
    },
  },
});
const linkRoute = createRoute({
  method: "post",
  path: "/plaid/link-token",
  ...options,
  responses: {
    200: {
      description: "Plaid Link token",
      content: { "application/json": { schema: LinkTokenResponseSchema } },
    },
    ...errors,
  },
});
const exchangeRoute = createRoute({
  method: "post",
  path: "/plaid/exchange",
  ...options,
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: ExchangePublicTokenBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Linked item",
      content: {
        "application/json": { schema: ExchangePublicTokenResponseSchema },
      },
    },
    ...errors,
  },
});
const refreshRoute = createRoute({
  method: "post",
  path: "/plaid/items/{itemId}/refresh",
  ...options,
  request: { params },
  responses: {
    200: {
      description: "Refreshed balances",
      content: {
        "application/json": { schema: RefreshItemBalancesResponseSchema },
      },
    },
    ...errors,
  },
});
const updateLinkRoute = createRoute({
  method: "post",
  path: "/plaid/items/{itemId}/update-link-token",
  ...options,
  request: { params },
  responses: {
    200: {
      description: "Plaid update-mode Link token",
      content: { "application/json": { schema: LinkTokenResponseSchema } },
    },
    ...errors,
  },
});
const unlinkRoute = createRoute({
  method: "delete",
  path: "/plaid/items/{itemId}",
  ...options,
  request: { params },
  responses: {
    200: {
      description: "Plaid item disconnected",
      content: {
        "application/json": { schema: DeletePlaidItemResponseSchema },
      },
    },
    ...errors,
  },
});

export function registerPlaidRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: Pick<
    PlaidService,
    | "listItems"
    | "createLinkToken"
    | "exchangePublicToken"
    | "refreshItemBalances"
    | "createUpdateLinkToken"
    | "unlinkItem"
  >,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(PlaidItemsResponseSchema, {
        items: await service.listItems(c.get("userId")),
      }),
      200,
    ),
  );
  app.openapi({ ...linkRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        LinkTokenResponseSchema,
        await service.createLinkToken(c.get("userId")),
      ),
      200,
    ),
  );
  app.openapi({ ...exchangeRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        ExchangePublicTokenResponseSchema,
        await service.exchangePublicToken(c.get("userId"), c.req.valid("json")),
      ),
      200,
    ),
  );
  app.openapi({ ...refreshRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(RefreshItemBalancesResponseSchema, {
        accounts: await service.refreshItemBalances(
          c.get("userId"),
          c.req.valid("param").itemId,
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...updateLinkRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        LinkTokenResponseSchema,
        await service.createUpdateLinkToken(
          c.get("userId"),
          c.req.valid("param").itemId,
        ),
      ),
      200,
    ),
  );
  app.openapi({ ...unlinkRoute, middleware: auth }, async (c) => {
    await service.unlinkItem(c.get("userId"), c.req.valid("param").itemId);
    return c.json(
      validateOutput(DeletePlaidItemResponseSchema, { ok: true }),
      200,
    );
  });
}
