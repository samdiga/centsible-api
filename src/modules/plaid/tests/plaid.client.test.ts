import { afterEach, expect, it, vi } from "vitest";
import { PlaidApi } from "plaid";
import { loadEnv } from "../../../platform/config/env.js";
import { createPlaidClient } from "../plaid.client.js";

afterEach(() => vi.restoreAllMocks());

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
  },
);
