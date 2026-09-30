import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createHttpApp,
  localAccountsConfig,
} from "../../../app/create-http-app.js";
import type { Env } from "../../../platform/config/env.js";
import { handleError } from "../../../platform/errors/error-handler.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import {
  isLocalHostHeader,
  isLoopbackAddress,
} from "../local-accounts.guard.js";
import { registerLocalAccountsRoutes } from "../local-accounts.routes.js";

const USER = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const PORT = 4000;

function setup(options: { user?: string | null; email?: string } = {}) {
  const plaid = {
    listItems: vi.fn(async () => [
      {
        id: ITEM,
        institutionId: "ins_1",
        institutionName: "Chase",
        status: "active",
        errorCode: null,
        errorMessage: null,
        initialSyncComplete: true,
        lastSuccessfulSyncAt: null,
        health: "ok",
      },
    ]),
    createLinkToken: vi.fn(async () => ({
      linkToken: "link-production-x",
      expiration: "2026-09-30T08:00:00Z",
    })),
    exchangePublicToken: vi.fn(async () => ({
      itemId: ITEM,
      restoredAccounts: [],
    })),
    createUpdateLinkToken: vi.fn(async () => ({
      linkToken: "link-production-u",
      expiration: "2026-09-30T08:00:00Z",
    })),
    unlinkItem: vi.fn(async () => undefined),
  };
  const accounts = {
    listAccountSummaries: vi.fn(async () => [
      {
        id: "a1",
        name: "Checking",
        mask: "4968",
        type: "depository",
        plaidItem: { id: ITEM },
      },
      { id: "a2", name: "Manual", mask: null, type: "other", plaidItem: null },
    ]),
  };
  const resolveUserId = vi.fn(async () =>
    options.user === undefined ? USER : options.user,
  );
  const logger = { info: vi.fn(), warn: vi.fn() };
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  registerLocalAccountsRoutes(app, {
    config: { email: options.email ?? "sam@example.test", port: PORT },
    plaid: plaid as never,
    accounts: accounts as never,
    resolveUserId,
    logger,
  });
  /** A request as the Node server delivers it: the socket's peer address. */
  const send = (
    path: string,
    init: RequestInit & { from?: string; host?: string } = {},
  ) => {
    const { from = "127.0.0.1", host = `localhost:${PORT}`, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("host", host);
    return app.request(path, { ...rest, headers }, {
      incoming: { socket: { remoteAddress: from } },
    } as never);
  };
  return { send, plaid, accounts, resolveUserId, logger };
}

const mutation = { "X-Centsy-Local": "1", "content-type": "application/json" };

describe("local accounts guard", () => {
  it("accepts only loopback peers and this machine's own Host", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
      expect(isLoopbackAddress(address)).toBe(true);
    for (const address of [undefined, "100.64.0.7", "192.168.1.5", "10.0.0.1"])
      expect(isLoopbackAddress(address)).toBe(false);
    expect(isLocalHostHeader("localhost:4000", 4000)).toBe(true);
    expect(isLocalHostHeader("127.0.0.1:4000", 4000)).toBe(true);
    for (const host of [
      undefined,
      "evil.test:4000",
      "localhost:4001",
      "localhost",
      "centsy.local:4000",
    ])
      expect(isLocalHostHeader(host, 4000)).toBe(false);
  });
});

describe("local accounts routes", () => {
  it("do not exist unless the flag is on with an email", async () => {
    const base = { PORT } as unknown as Env;
    expect(localAccountsConfig(undefined)).toBeUndefined();
    expect(
      localAccountsConfig({
        ...base,
        LOCAL_ACCOUNTS_PAGE: false,
        LOCAL_ACCOUNTS_USER_EMAIL: "a@b.c",
      }),
    ).toBeUndefined();
    expect(
      localAccountsConfig({ ...base, LOCAL_ACCOUNTS_PAGE: true }),
    ).toBeUndefined();
    expect(
      localAccountsConfig({
        ...base,
        LOCAL_ACCOUNTS_PAGE: true,
        LOCAL_ACCOUNTS_USER_EMAIL: "a@b.c",
      }),
    ).toEqual({ email: "a@b.c", port: PORT });

    const app = createHttpApp({ auth: async (_c, next) => next() });
    const response = await app.request(
      "/local/accounts",
      { headers: { host: "localhost:4000" } },
      {
        incoming: { socket: { remoteAddress: "127.0.0.1" } },
      } as never,
    );
    expect(response.status).toBe(404);
  });

  it("serves the page to this Mac, naming the user safely", async () => {
    const { send } = setup({ email: "sam+<b>@example.test" });
    const response = await send("/local/accounts");
    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin-allow-popups",
    );
    const html = await response.text();
    expect(html).toContain(
      "Linking banks for <strong>sam+&lt;b&gt;@example.test</strong>",
    );
    expect(html).toContain(
      "https://cdn.plaid.com/link/v2/stable/link-initialize.js",
    );
  });

  it("is invisible to another machine, even one claiming to be local", async () => {
    const { send, plaid } = setup();
    expect(
      (await send("/local/accounts", { from: "100.101.102.103" })).status,
    ).toBe(404);
    // X-Forwarded-For is the caller's word; only the socket counts.
    const spoofed = await send("/local/plaid/items", {
      from: "100.101.102.103",
      headers: { "X-Forwarded-For": "127.0.0.1" },
    });
    expect(spoofed.status).toBe(404);
    expect(plaid.listItems).not.toHaveBeenCalled();
  });

  it("rejects a foreign Host (DNS rebinding) and a missing mutation header", async () => {
    const { send, plaid } = setup();
    expect(
      (await send("/local/plaid/items", { host: "evil.test:4000" })).status,
    ).toBe(404);
    expect(
      (await send("/local/plaid/items", { host: `localhost:${PORT + 1}` }))
        .status,
    ).toBe(404);
    const noHeader = await send("/local/plaid/link-token", { method: "POST" });
    expect(noHeader.status).toBe(404);
    expect(plaid.createLinkToken).not.toHaveBeenCalled();
  });

  it("answers 404 and logs once when the email matches no user", async () => {
    const { send, logger, resolveUserId } = setup({ user: null });
    expect((await send("/local/accounts")).status).toBe(404);
    expect((await send("/local/plaid/items")).status).toBe(404);
    expect(resolveUserId).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("delegates every action to the app's own services as the configured user", async () => {
    const { send, plaid, accounts } = setup();

    const list = await send("/local/plaid/items");
    expect(await list.json()).toEqual({
      items: [
        expect.objectContaining({
          id: ITEM,
          institutionName: "Chase",
          health: "ok",
          accounts: [
            { id: "a1", name: "Checking", mask: "4968", type: "depository" },
          ],
        }),
      ],
    });
    expect(plaid.listItems).toHaveBeenCalledWith(USER);
    expect(accounts.listAccountSummaries).toHaveBeenCalledWith(USER);

    const token = await send("/local/plaid/link-token", {
      method: "POST",
      headers: mutation,
    });
    expect(await token.json()).toMatchObject({
      linkToken: "link-production-x",
    });
    expect(plaid.createLinkToken).toHaveBeenCalledWith(USER);

    const body = {
      publicToken: "public-x",
      institution: { id: "ins_1", name: "Chase" },
    };
    const exchanged = await send("/local/plaid/exchange", {
      method: "POST",
      headers: mutation,
      body: JSON.stringify(body),
    });
    expect(exchanged.status).toBe(200);
    expect(plaid.exchangePublicToken).toHaveBeenCalledWith(USER, body);

    await send(`/local/plaid/items/${ITEM}/update-link-token`, {
      method: "POST",
      headers: mutation,
    });
    expect(plaid.createUpdateLinkToken).toHaveBeenCalledWith(USER, ITEM);

    const removed = await send(`/local/plaid/items/${ITEM}`, {
      method: "DELETE",
      headers: mutation,
    });
    expect(await removed.json()).toEqual({ ok: true });
    expect(plaid.unlinkItem).toHaveBeenCalledWith(USER, ITEM);
  });

  it("rejects a malformed exchange without calling Plaid", async () => {
    const { send, plaid } = setup();
    const response = await send("/local/plaid/exchange", {
      method: "POST",
      headers: mutation,
      body: JSON.stringify({ publicToken: "" }),
    });
    expect(response.status).toBe(400);
    expect(plaid.exchangePublicToken).not.toHaveBeenCalled();
  });
});
