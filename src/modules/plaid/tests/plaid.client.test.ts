import { afterEach, expect, it, vi } from "vitest";
import { PlaidApi } from "plaid";
import { loadEnv } from "../../../platform/config/env.js";
import { createPlaidClient } from "../plaid.client.js";

afterEach(() => vi.restoreAllMocks());

it("creates new Link tokens with Transactions only", async () => {
  const request = vi
    .spyOn(PlaidApi.prototype, "linkTokenCreate")
    .mockResolvedValue({
      data: { link_token: "new-token", expiration: "2026-10-05" },
    } as Awaited<ReturnType<PlaidApi["linkTokenCreate"]>>);
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@example.test/centsible",
    DATABASE_ENVIRONMENT: "sandbox",
    PLAID_CLIENT_ID: "client",
    PLAID_SECRET: "secret",
  });

  await createPlaidClient(() => env).createLinkToken("user");

  expect(request.mock.calls[0]?.[0].products).toEqual(["transactions"]);
  expect(request.mock.calls[0]?.[0].optional_products).toBeUndefined();
  expect(
    request.mock.calls[0]?.[0].additional_consented_products,
  ).toBeUndefined();
});

it.each(["createLinkToken", "createUpdateLinkToken"] as const)(
  "%s asks for Liabilities consent without making it a required product",
  async (method) => {
    const request = vi
      .spyOn(PlaidApi.prototype, "linkTokenCreate")
      .mockResolvedValue({
        data: { link_token: "token", expiration: "2026-10-05" },
      } as Awaited<ReturnType<PlaidApi["linkTokenCreate"]>>);
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@example.test/centsible",
      DATABASE_ENVIRONMENT: "sandbox",
      PLAID_CLIENT_ID: "client",
      PLAID_SECRET: "secret",
    });
    const client = createPlaidClient(() => env);

    if (method === "createLinkToken")
      await client.createLinkToken("user", { liabilities: true });
    else
      await client.createUpdateLinkToken("user", "access-test", {
        liabilities: true,
      });

    const body = request.mock.calls[0]?.[0];
    expect(body?.additional_consented_products).toEqual(["liabilities"]);
    expect(body?.optional_products).toBeUndefined();
    expect(body?.products).toEqual(
      method === "createLinkToken" ? ["transactions"] : undefined,
    );
  },
);

it.each([undefined, "https://example.test/oauth"])(
  "enables update account selection and preserves configured OAuth redirect %s",
  async (redirect) => {
    const request = vi
      .spyOn(PlaidApi.prototype, "linkTokenCreate")
      .mockResolvedValue({
        data: { link_token: "update-token", expiration: "2026-10-01" },
      } as Awaited<ReturnType<PlaidApi["linkTokenCreate"]>>);
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@example.test/centsible",
      DATABASE_ENVIRONMENT: "sandbox",
      PLAID_CLIENT_ID: "client",
      PLAID_SECRET: "secret",
      ...(redirect ? { PLAID_REDIRECT_URI: redirect } : {}),
    });
    expect(
      await createPlaidClient(() => env).createUpdateLinkToken(
        "user",
        "access-test",
      ),
    ).toEqual({ linkToken: "update-token", expiration: "2026-10-01" });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      user: { client_user_id: "user" },
      access_token: "access-test",
      update: { account_selection_enabled: true },
    });
    expect(request.mock.calls[0]?.[0].redirect_uri).toBe(redirect);
    expect(request.mock.calls[0]?.[0].products).toBeUndefined();
    expect(
      request.mock.calls[0]?.[0].additional_consented_products,
    ).toBeUndefined();
  },
);
