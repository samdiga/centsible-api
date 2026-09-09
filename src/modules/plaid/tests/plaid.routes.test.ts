import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { expect, it, vi } from "vitest";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import { registerPlaidRoutes } from "../plaid.routes.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("userId", USER_ID);
  await next();
};

it("registers the six private Plaid routes with their established wire shapes", async () => {
  const service = {
    listItems: vi.fn(async () => [
      {
        id: ITEM_ID,
        institutionId: "ins_1",
        institutionName: "Test Bank",
        status: "active" as const,
        errorCode: null,
        errorMessage: null,
        initialSyncComplete: true,
      },
    ]),
    createLinkToken: vi.fn(async () => ({
      linkToken: "link-token",
      expiration: "2026-09-10T00:00:00.000Z",
    })),
    exchangePublicToken: vi.fn(async () => ({ itemId: ITEM_ID })),
    refreshItemBalances: vi.fn(async () => [
      {
        accountId: ACCOUNT_ID,
        plaidAccountId: "plaid-account",
        current: 10,
        available: 8,
        limit: null,
        currency: "USD",
      },
    ]),
    createUpdateLinkToken: vi.fn(async () => ({
      linkToken: "update-token",
      expiration: "2026-09-10T00:00:00.000Z",
    })),
    unlinkItem: vi.fn(async () => undefined),
  };
  const app = new OpenAPIHono<AppEnv>();
  registerPlaidRoutes(app, auth, service);

  await expect((await app.request("/plaid/items")).json()).resolves.toEqual({
    items: await service.listItems(),
  });
  await expect(
    (await app.request("/plaid/link-token", { method: "POST" })).json(),
  ).resolves.toEqual({
    linkToken: "link-token",
    expiration: "2026-09-10T00:00:00.000Z",
  });
  const exchange = await app.request("/plaid/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicToken: "public-token",
      institution: { id: "ins_1", name: "Test Bank" },
    }),
  });
  expect(exchange.status).toBe(200);
  await expect(exchange.json()).resolves.toEqual({ itemId: ITEM_ID });
  await expect(
    (
      await app.request(`/plaid/items/${ITEM_ID}/refresh`, { method: "POST" })
    ).json(),
  ).resolves.toEqual({
    accounts: await service.refreshItemBalances(),
  });
  await expect(
    (
      await app.request(`/plaid/items/${ITEM_ID}/update-link-token`, {
        method: "POST",
      })
    ).json(),
  ).resolves.toEqual({
    linkToken: "update-token",
    expiration: "2026-09-10T00:00:00.000Z",
  });
  await expect(
    (await app.request(`/plaid/items/${ITEM_ID}`, { method: "DELETE" })).json(),
  ).resolves.toEqual({ ok: true });

  expect(service.exchangePublicToken).toHaveBeenCalledWith(USER_ID, {
    publicToken: "public-token",
    institution: { id: "ins_1", name: "Test Bank" },
  });
  expect(service.refreshItemBalances).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  expect(service.createUpdateLinkToken).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  expect(service.unlinkItem).toHaveBeenCalledWith(USER_ID, ITEM_ID);
});
