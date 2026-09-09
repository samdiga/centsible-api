import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import type { AccountService } from "../accounts.service.js";
import {
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from "../../../platform/errors/app-error.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const account = {
  id: ACCOUNT_ID,
  name: "Checking",
  officialName: null,
  mask: "1234",
  type: "depository" as const,
  subtype: "checking" as const,
  currency: "USD",
  currentBalance: "12345",
  availableBalance: null,
  institutionName: "Example Bank",
  lastSyncAt: "2026-09-01T00:00:00.000Z",
  isHidden: false,
  plaidItem: {
    id: "33333333-3333-4333-8333-333333333333",
    status: "active" as const,
    errorCode: null,
  },
};

const service: AccountService = {
  listAccountSummaries: vi.fn(async () => [account]),
  refreshAccountBalance: vi.fn(async () => ({
    accountId: ACCOUNT_ID,
    plaidAccountId: "plaid-account",
    current: 123.45,
    available: null,
    limit: null,
    currency: "USD",
  })),
  removeAccount: vi.fn(async () => ({ removed: true, unlinkedItem: true })),
};

function app() {
  return createHttpApp({ auth, accountsService: service });
}

describe("accounts routes", () => {
  it("returns bigint-safe account summary wire values", async () => {
    const response = await app().request("/accounts", {
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      accounts: [{ currentBalance: "12345", availableBalance: null }],
    });
    expect(JSON.stringify(body)).not.toContain("12345n");
  });

  it("validates account UUIDs and returns the refresh response shape", async () => {
    const invalid = await app().request(
      "/accounts/not-a-uuid/refresh-balance",
      {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      },
    );
    expect(invalid.status).toBe(400);

    const response = await app().request(
      `/accounts/${ACCOUNT_ID}/refresh-balance`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account: { current: 123.45 },
    });
  });

  it("returns the documented delete result", async () => {
    const response = await app().request(`/accounts/${ACCOUNT_ID}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, unlinkedItem: true });
  });

  it("maps a missing delete target to the stable not-found envelope", async () => {
    vi.mocked(service.removeAccount).mockResolvedValueOnce({
      removed: false,
      unlinkedItem: false,
    });
    const response = await app().request(`/accounts/${ACCOUNT_ID}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
      requestId: expect.any(String),
    });
  });

  it("requires authentication", async () => {
    const response = await createHttpApp({ accountsService: service }).request(
      "/accounts",
    );
    expect(response.status).toBe(401);
  });

  it("uses typed upstream and not-found envelopes for refresh failures", async () => {
    vi.mocked(service.refreshAccountBalance).mockRejectedValueOnce(
      new UpstreamError(),
    );
    const defaultResponse = await app().request(
      `/accounts/${ACCOUNT_ID}/refresh-balance`,
      { method: "POST", headers: { authorization: "Bearer test-token" } },
    );
    expect(defaultResponse.status).toBe(502);
    expect(await defaultResponse.json()).toMatchObject({
      error: { code: "UPSTREAM_FAILURE" },
    });

    vi.mocked(service.refreshAccountBalance).mockRejectedValueOnce(
      new NotFoundError("account"),
    );
    const missingResponse = await app().request(
      `/accounts/${ACCOUNT_ID}/refresh-balance`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      },
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("preserves typed rate-limit refresh failures", async () => {
    vi.mocked(service.refreshAccountBalance).mockRejectedValueOnce(
      new RateLimitError(9),
    );
    const response = await app().request(
      `/accounts/${ACCOUNT_ID}/refresh-balance`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
  });
});
