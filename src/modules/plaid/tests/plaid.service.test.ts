import { expect, it, vi } from "vitest";
import type { PlaidAccountData } from "../../accounts/accounts.schemas.js";
import { createPlaidService } from "../plaid.service.js";
import type { PlaidItemRow } from "../plaid-items.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const item: PlaidItemRow = {
  id: ITEM_ID,
  userId: USER_ID,
  plaidItemId: "plaid-item",
  institutionId: "ins_1",
  institutionName: "Test Bank",
  accessTokenEncrypted: "encrypted",
  accessTokenNonce: "nonce",
  cursor: null,
  status: "active" as const,
  errorCode: null,
  errorMessage: null,
  availableProducts: [],
  billedProducts: [],
  consentedProducts: [],
  liabilitiesStatus: null,
  lastSyncAt: null,
  bankLastUpdatedAt: null,
  lastWebhookAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

function dependencies() {
  const repository = {
    listByUser: vi.fn(async () => [item]),
    findById: vi.fn(async () => item),
    findByPlaidItemId: vi.fn(async () => null),
    create: vi.fn(async () => item),
    softDelete: vi.fn(async () => true),
    isFeatureEnabled: vi.fn<(flag: string, userId: string) => Promise<boolean>>(
      async () => true,
    ),
    ensureUserSchedule: vi.fn(async () => undefined),
    markStatus: vi.fn(async () => undefined),
    findLiveAccountMatches: vi.fn(
      async (): Promise<
        Array<{
          itemId: string;
          institutionName: string | null;
          accountId: string;
          name: string;
          mask: string | null;
        }>
      > => [],
    ),
  };
  const client = {
    createLinkToken: vi.fn(async () => ({
      linkToken: "link-token",
      expiration: "2026-09-10T00:00:00.000Z",
    })),
    exchangePublicToken: vi.fn(async () => ({
      accessToken: "access-secret",
      plaidItemId: "plaid-item",
    })),
    createUpdateLinkToken: vi.fn(async () => ({
      linkToken: "update-token",
      expiration: "2026-09-10T00:00:00.000Z",
    })),
    getAccounts: vi.fn(async (): Promise<PlaidAccountData[]> => []),
    removeItem: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const tx = {};
  const withUserMutation = vi.fn(
    async (_userId: string, callback: (value: object) => Promise<unknown>) =>
      callback(tx),
  );
  const startPipeline = vi.fn(async () => ({
    runId: "33333333-3333-4333-8333-333333333333",
    deduped: false,
  }));
  return {
    repository,
    client,
    audit,
    withUserMutation,
    startPipeline,
    cipher: {
      encrypt: vi.fn(() => ({ encrypted: "encrypted", nonce: "nonce" })),
      decrypt: vi.fn(() => "access-secret"),
    },
    consume: vi.fn(),
    logger: { warn: vi.fn() },
    accounts: {
      findById: vi.fn(),
      updateBalances: vi.fn(),
    },
  };
}

it("maps linked items without exposing encrypted tokens", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);

  await expect(service.listItems(USER_ID)).resolves.toEqual([
    {
      id: ITEM_ID,
      institutionId: "ins_1",
      institutionName: "Test Bank",
      status: "active",
      errorCode: null,
      errorMessage: null,
      initialSyncComplete: false,
      lastSuccessfulSyncAt: null,
      health: "ok",
      liabilitiesConsentRequired: false,
      bankLastUpdatedAt: null,
      bankNotRefreshing: false,
    },
  ]);
});

it("flags a connection whose bank needs sharing re-approved for statements", async () => {
  const deps = dependencies();
  deps.repository.listByUser.mockResolvedValueOnce([
    { ...item, liabilitiesStatus: "consent_required" },
  ]);
  const [summary] = await createPlaidService(deps as never).listItems(USER_ID);
  expect(summary?.liabilitiesConsentRequired).toBe(true);
});

it("asks a new link for Liabilities while the Liabilities flag is on", async () => {
  const deps = dependencies();
  await createPlaidService(deps as never).createLinkToken(USER_ID);
  expect(deps.client.createLinkToken).toHaveBeenCalledWith(USER_ID, {
    liabilities: true,
  });
});

it("leaves Liabilities out of a new link when the Liabilities flag is off", async () => {
  const deps = dependencies();
  deps.repository.isFeatureEnabled.mockImplementation(
    async (flag: string) => flag !== "plaid_liabilities_enabled",
  );
  await createPlaidService(deps as never).createLinkToken(USER_ID);
  expect(deps.client.createLinkToken).toHaveBeenCalledWith(USER_ID, {
    liabilities: false,
  });
});

it("asks a reconnect for Liabilities only when the bank said consent is missing", async () => {
  for (const [liabilitiesStatus, expected] of [
    ["consent_required", true],
    ["available", false],
    ["not_supported", false],
    [null, false],
  ] as const) {
    const deps = dependencies();
    deps.repository.findById.mockResolvedValueOnce({
      ...item,
      liabilitiesStatus,
    });
    await createPlaidService(deps as never).createUpdateLinkToken(
      USER_ID,
      ITEM_ID,
    );
    expect(deps.client.createUpdateLinkToken).toHaveBeenCalledWith(
      USER_ID,
      "access-secret",
      { liabilities: expected },
    );
  }
});

it("marks a still-syncing active item ok even without a completed sync", async () => {
  const deps = dependencies();
  deps.repository.listByUser.mockResolvedValueOnce([
    { ...item, cursor: null, lastSyncAt: null },
  ]);
  const service = createPlaidService(deps as never);

  const [summary] = await service.listItems(USER_ID);
  expect(summary?.health).toBe("ok");
  expect(summary?.initialSyncComplete).toBe(false);
});

it("marks an active item with a completed sync older than 72h as stale", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
  const deps = dependencies();
  deps.repository.listByUser.mockResolvedValueOnce([
    {
      ...item,
      cursor: "cursor-1",
      lastSyncAt: new Date("2026-09-06T00:00:00.000Z"),
    },
  ]);
  const service = createPlaidService(deps as never);

  const [summary] = await service.listItems(USER_ID);
  expect(summary?.health).toBe("stale");
  expect(summary?.lastSuccessfulSyncAt).toBe("2026-09-06T00:00:00.000Z");
  vi.useRealTimers();
});

it("marks an active item with a recent completed sync as ok", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
  const deps = dependencies();
  deps.repository.listByUser.mockResolvedValueOnce([
    {
      ...item,
      cursor: "cursor-1",
      lastSyncAt: new Date("2026-09-09T12:00:00.000Z"),
    },
  ]);
  const service = createPlaidService(deps as never);

  const [summary] = await service.listItems(USER_ID);
  expect(summary?.health).toBe("ok");
  vi.useRealTimers();
});

it("maps login_required and pending_expiration statuses to their health values", async () => {
  const deps = dependencies();
  deps.repository.listByUser.mockResolvedValueOnce([
    { ...item, status: "login_required" as const },
  ]);
  const loginService = createPlaidService(deps as never);
  const [loginSummary] = await loginService.listItems(USER_ID);
  expect(loginSummary?.health).toBe("needs_relink");

  const pendingDeps = dependencies();
  pendingDeps.repository.listByUser.mockResolvedValueOnce([
    { ...item, status: "pending_expiration" as const },
  ]);
  const pendingService = createPlaidService(pendingDeps as never);
  const [pendingSummary] = await pendingService.listItems(USER_ID);
  expect(pendingSummary?.health).toBe("expiring");
});

it("persists an exchanged token, audits once, bootstraps sync, and starts a run", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);

  await expect(
    service.exchangePublicToken(USER_ID, {
      publicToken: "public-token",
      institution: { id: "ins_1", name: "Test Bank" },
    }),
  ).resolves.toEqual({ itemId: ITEM_ID, restoredAccounts: [] });

  expect(deps.repository.create).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: USER_ID,
      plaidItemId: "plaid-item",
      accessToken: { encrypted: "encrypted", nonce: "nonce" },
    }),
    expect.anything(),
  );
  expect(deps.withUserMutation).toHaveBeenCalledOnce();
  expect(deps.audit.record).toHaveBeenCalledOnce();
  expect(deps.repository.ensureUserSchedule).toHaveBeenCalledOnce();
  expect(deps.startPipeline).toHaveBeenCalledWith({
    userId: USER_ID,
    trigger: "manual",
  });
});

const macys = {
  publicToken: "public-token",
  institution: { id: "ins_citi", name: "Macy's - Citi Card" },
  accounts: [
    {
      id: "new-plaid-account",
      name: "Macy's American Express® Card",
      mask: "6051",
      type: "credit",
      subtype: "credit card",
    },
  ],
};

it("refuses to link an account the user already has, before exchanging the token", async () => {
  const deps = dependencies();
  deps.repository.findLiveAccountMatches.mockResolvedValueOnce([
    {
      itemId: ITEM_ID,
      institutionName: "Macy's - Citi Card",
      accountId: "44444444-4444-4444-8444-444444444444",
      // The user's nickname: matching is on mask + type, never the name.
      name: "Macy's AMEX",
      mask: "6051",
    },
  ]);
  const service = createPlaidService(deps as never);

  await expect(service.exchangePublicToken(USER_ID, macys)).rejects.toMatchObject({
    code: "PLAID_DUPLICATE_ITEM",
    httpStatus: 409,
    details: {
      itemId: ITEM_ID,
      institutionName: "Macy's - Citi Card",
      accounts: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          name: "Macy's AMEX",
          mask: "6051",
        },
      ],
    },
  });
  expect(deps.repository.findLiveAccountMatches).toHaveBeenCalledWith(
    USER_ID,
    "ins_citi",
    [{ mask: "6051", type: "credit", subtype: "credit_card" }],
  );
  expect(deps.client.exchangePublicToken).not.toHaveBeenCalled();
  expect(deps.repository.create).not.toHaveBeenCalled();
});

it("blocks a link that adds a new card alongside one already linked, naming only the existing ones", async () => {
  const deps = dependencies();
  deps.repository.findLiveAccountMatches.mockResolvedValueOnce([
    {
      itemId: ITEM_ID,
      institutionName: "Macy's - Citi Card",
      accountId: "44444444-4444-4444-8444-444444444444",
      name: "Macy's AMEX",
      mask: "6051",
    },
  ]);
  const service = createPlaidService(deps as never);
  const withNewCard = {
    ...macys,
    accounts: [
      ...macys.accounts,
      { id: "p2", name: "Citi Rewards", mask: "1234", type: "credit", subtype: "credit card" },
    ],
  };

  await expect(
    service.exchangePublicToken(USER_ID, withNewCard),
  ).rejects.toMatchObject({
    code: "PLAID_DUPLICATE_ITEM",
    details: { accounts: [{ mask: "6051" }] },
  });
  expect(deps.client.exchangePublicToken).not.toHaveBeenCalled();
});

it("links normally when no account matches, and never looks up accounts without a mask", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);
  await service.exchangePublicToken(USER_ID, {
    ...macys,
    accounts: [{ ...macys.accounts[0]!, mask: null }],
  });
  expect(deps.repository.findLiveAccountMatches).toHaveBeenCalledWith(
    USER_ID,
    "ins_citi",
    [],
  );
  expect(deps.client.exchangePublicToken).toHaveBeenCalledOnce();
});

it("disconnects locally when Plaid item removal fails", async () => {
  const deps = dependencies();
  deps.client.removeItem.mockRejectedValueOnce(new Error("provider secret"));
  const service = createPlaidService(deps as never);

  await expect(service.unlinkItem(USER_ID, ITEM_ID)).resolves.toBeUndefined();
  expect(deps.repository.softDelete).toHaveBeenCalledWith(
    ITEM_ID,
    USER_ID,
    expect.anything(),
  );
  expect(deps.audit.record).toHaveBeenCalledOnce();
  expect(deps.logger.warn).toHaveBeenCalledOnce();
});

it("does not clear a login error after reading cached accounts", async () => {
  const deps = dependencies();
  deps.repository.findById.mockResolvedValueOnce({
    ...item,
    status: "login_required" as const,
    errorCode: "ITEM_LOGIN_REQUIRED",
    errorMessage: "relink required",
  });
  const service = createPlaidService(deps as never);

  await expect(
    service.refreshCachedAccountsForItem(USER_ID, ITEM_ID),
  ).resolves.toEqual([]);

  expect(deps.repository.markStatus).not.toHaveBeenCalled();
});

it("does not touch status on a cached refresh for an already-active item", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);

  await expect(
    service.refreshCachedAccountsForItem(USER_ID, ITEM_ID),
  ).resolves.toEqual([]);

  expect(deps.repository.markStatus).not.toHaveBeenCalled();
});

it("uses cached account data for an explicit item refresh without calling paid Balance", async () => {
  const deps = dependencies();
  const account = {
    account_id: "plaid-account",
    name: "Checking",
    type: "depository",
    balances: {
      current: 120,
      available: 100,
      limit: null,
      iso_currency_code: "USD",
    },
  };
  deps.client.getAccounts.mockResolvedValueOnce([account]);
  deps.accounts.updateBalances.mockResolvedValueOnce({ id: "local-account" });
  const service = createPlaidService(deps as never);

  await expect(
    service.refreshCachedAccountsForItem(USER_ID, ITEM_ID),
  ).resolves.toEqual([
    {
      accountId: "local-account",
      plaidAccountId: "plaid-account",
      current: 120,
      available: 100,
      limit: null,
      currency: "USD",
    },
  ]);
  expect(deps.client.getAccounts).toHaveBeenCalledWith("access-secret");
  expect(deps.accounts.updateBalances).toHaveBeenCalledWith(
    "plaid-account",
    USER_ID,
    account.balances,
    expect.anything(),
  );
});

it("revokes every active item before destructive user-data operations", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);

  await expect(service.revokeAllItems(USER_ID)).resolves.toBeUndefined();
  expect(deps.client.removeItem).toHaveBeenCalledWith("access-secret");
});

it("reports removed accounts a new link took over, and not brand-new ones", async () => {
  const deps = dependencies();
  const linkedAt = new Date("2026-09-25T10:00:00.000Z");
  deps.repository.create.mockResolvedValueOnce({
    ...item,
    createdAt: linkedAt,
  });
  const plaidAccount = (id: string) => ({
    account_id: id,
    name: id,
    type: "credit",
    subtype: "credit card",
    mask: "1001",
    balances: { current: 1, available: null, limit: null },
  });
  const client = {
    ...deps.client,
    getAccounts: vi.fn(async () => [plaidAccount("old"), plaidAccount("new")]),
  };
  const upsertFromPlaid = vi.fn(
    async ({ account }: { account: { account_id: string } }) => ({
      id: `row-${account.account_id}`,
      userId: USER_ID,
      plaidItemId: ITEM_ID,
      plaidAccountId: account.account_id,
      name: account.account_id === "old" ? "Platinum Card" : "Checking",
      mask: "1001",
      createdAt:
        account.account_id === "old"
          ? new Date("2026-09-01T00:00:00.000Z")
          : new Date(linkedAt.getTime() + 1000),
    }),
  );
  const service = createPlaidService({
    ...deps,
    client,
    accountWriter: { upsertFromPlaid, findByPlaidAccountIds: vi.fn() },
  } as never);

  await expect(
    service.exchangePublicToken(USER_ID, {
      publicToken: "public-token",
      institution: { id: "ins_1", name: "Test Bank" },
    }),
  ).resolves.toEqual({
    itemId: ITEM_ID,
    restoredAccounts: [{ id: "row-old", name: "Platinum Card", mask: "1001" }],
  });
});

it("fetches statements straight after a refresh only when the bank needed consent", async () => {
  for (const [liabilitiesStatus, starts] of [
    ["consent_required", 1],
    ["available", 0],
    [null, 0],
  ] as const) {
    const deps = dependencies();
    deps.repository.findById.mockResolvedValue({ ...item, liabilitiesStatus });
    await createPlaidService(deps as never).refreshCachedAccountsForItem(
      USER_ID,
      ITEM_ID,
    );
    expect(deps.startPipeline).toHaveBeenCalledTimes(starts);
  }
});
