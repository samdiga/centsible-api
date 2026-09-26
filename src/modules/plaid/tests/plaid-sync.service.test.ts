import { expect, it, vi } from "vitest";
import { createPlaidSyncService } from "../plaid-sync.service.js";

/** Sync tests that aren't about categorisation skip it. */
const noCategorizer = {
  existingPlaidIds: vi.fn(async () => new Set<string>()),
  categorize: vi.fn(async () => ({ fromHistory: 0, fromBank: 0 })),
};

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

it("resets a previously broken item to active on a fully successful sync", async () => {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    cursor: null,
    status: "login_required" as const,
    errorCode: "ITEM_LOGIN_REQUIRED",
    errorMessage: "relink required",
    accessTokenEncrypted: "encrypted",
    accessTokenNonce: "nonce",
  };
  const page = {
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    nextCursor: "cursor-1",
    hasMore: false,
    rawPayload: {},
  };
  const markStatus = vi.fn(async () => undefined);
  const markSynced = vi.fn(async () => undefined);
  const audit = { record: vi.fn(async () => undefined) };
  const mutationTx = { id: "sync-completion" };
  const withUserMutation = vi.fn(
    async (_userId: string, callback: (tx: object) => Promise<unknown>) =>
      callback(mutationTx),
  );
  const service = createPlaidSyncService({
    categorizer: noCategorizer,
    items: {
      findByUuid: vi.fn(async () => item),
      isFeatureEnabled: vi.fn(async () => true),
      advanceCursor: vi.fn(async () => true),
      markSynced,
      markStatus,
    },
    client: { syncTransactions: vi.fn(async () => page) },
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: {
      upsertFromPlaid: vi.fn(async () => ({
        id: "33333333-3333-4333-8333-333333333333",
      })),
      findByPlaidAccountIds: vi.fn(async () => []),
    },
    transactions: {
      upsertManyFromPlaid: vi.fn(async () => []),
      softDeleteByPlaidIds: vi.fn(async () => undefined),
    },
    rules: { listActiveRules: vi.fn(async () => []) },
    rawImports: { record: vi.fn(async () => undefined) },
    audit,
    transaction: async (callback: (tx: object) => Promise<unknown>) =>
      callback({}),
    withUserMutation,
  } as never);

  await service.syncItem(USER_ID, ITEM_ID);

  expect(withUserMutation).toHaveBeenCalledOnce();
  expect(markSynced).toHaveBeenCalledWith(ITEM_ID, mutationTx);
  expect(markStatus).toHaveBeenCalledWith(
    ITEM_ID,
    "active",
    null,
    null,
    mutationTx,
  );
  expect(audit.record).toHaveBeenCalledWith(
    expect.objectContaining({ after: { status: "active" } }),
    mutationTx,
  );
});

it("leaves an already-active item's status untouched on sync success", async () => {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    cursor: null,
    status: "active" as const,
    errorCode: null,
    errorMessage: null,
    accessTokenEncrypted: "encrypted",
    accessTokenNonce: "nonce",
  };
  const page = {
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    nextCursor: "cursor-1",
    hasMore: false,
    rawPayload: {},
  };
  const markStatus = vi.fn(async () => undefined);
  const service = createPlaidSyncService({
    categorizer: noCategorizer,
    items: {
      findByUuid: vi.fn(async () => item),
      isFeatureEnabled: vi.fn(async () => true),
      advanceCursor: vi.fn(async () => true),
      markSynced: vi.fn(async () => undefined),
      markStatus,
    },
    client: { syncTransactions: vi.fn(async () => page) },
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: {
      upsertFromPlaid: vi.fn(async () => ({
        id: "33333333-3333-4333-8333-333333333333",
      })),
      findByPlaidAccountIds: vi.fn(async () => []),
    },
    transactions: {
      upsertManyFromPlaid: vi.fn(async () => []),
      softDeleteByPlaidIds: vi.fn(async () => undefined),
    },
    rules: { listActiveRules: vi.fn(async () => []) },
    rawImports: { record: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) },
    transaction: async (callback: (tx: object) => Promise<unknown>) =>
      callback({}),
    withUserMutation: vi.fn(
      async (_userId: string, callback: (tx: object) => Promise<unknown>) =>
        callback({}),
    ),
  } as never);

  await service.syncItem(USER_ID, ITEM_ID);

  expect(markStatus).not.toHaveBeenCalled();
});

it("applies every sync page, advances the cursor, and publishes one mutation", async () => {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    cursor: null,
    status: "active" as const,
    errorCode: null,
    errorMessage: null,
    accessTokenEncrypted: "encrypted",
    accessTokenNonce: "nonce",
  };
  const page = (input: {
    added?: string[];
    modified?: string[];
    removed?: string[];
    cursor: string;
    more: boolean;
  }) => ({
    accounts: [
      {
        account_id: "plaid-account",
        name: "Checking",
        type: "depository",
        subtype: "checking",
        balances: { current: 10, available: 8, iso_currency_code: "USD" },
      },
    ],
    added: (input.added ?? []).map((id) => ({
      transaction_id: id,
      account_id: "plaid-account",
      amount: 2.5,
      date: "2026-09-09",
      pending: false,
      name: "Coffee",
    })),
    modified: (input.modified ?? []).map((id) => ({
      transaction_id: id,
      account_id: "plaid-account",
      amount: 3,
      date: "2026-09-09",
      pending: false,
      name: "Coffee updated",
    })),
    removed: (input.removed ?? []).map((transaction_id) => ({
      transaction_id,
    })),
    nextCursor: input.cursor,
    hasMore: input.more,
    rawPayload: { next_cursor: input.cursor },
  });
  const syncTransactions = vi
    .fn()
    .mockResolvedValueOnce(
      page({ added: ["txn-1", "txn-2"], cursor: "cursor-1", more: true }),
    )
    .mockResolvedValueOnce(
      page({
        modified: ["txn-1"],
        removed: ["txn-old"],
        cursor: "cursor-2",
        more: false,
      }),
    );
  const advanceCursor = vi.fn(async () => true);
  const upsertManyFromPlaid = vi.fn(async () => []);
  const softDeleteByPlaidIds = vi.fn(async () => undefined);
  const withUserMutation = vi.fn(
    async (_userId: string, callback: (tx: object) => Promise<unknown>) =>
      callback({}),
  );
  const service = createPlaidSyncService({
    categorizer: noCategorizer,
    items: {
      findByUuid: vi.fn(async () => item),
      isFeatureEnabled: vi.fn(async () => true),
      advanceCursor,
      markSynced: vi.fn(async () => undefined),
      markStatus: vi.fn(async () => undefined),
    },
    client: { syncTransactions },
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: {
      upsertFromPlaid: vi.fn(async () => ({
        id: "33333333-3333-4333-8333-333333333333",
      })),
      findByPlaidAccountIds: vi.fn(async () => []),
    },
    transactions: { upsertManyFromPlaid, softDeleteByPlaidIds },
    rules: { listActiveRules: vi.fn(async () => []) },
    rawImports: { record: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) },
    transaction: async (callback: (tx: object) => Promise<unknown>) =>
      callback({}),
    withUserMutation,
  } as never);

  await expect(service.syncItem(USER_ID, ITEM_ID)).resolves.toEqual({
    added: 2,
    modified: 1,
    removed: 1,
    pages: 2,
  });
  expect(syncTransactions).toHaveBeenNthCalledWith(
    1,
    "access-token",
    undefined,
  );
  expect(syncTransactions).toHaveBeenNthCalledWith(
    2,
    "access-token",
    "cursor-1",
  );
  expect(advanceCursor).toHaveBeenNthCalledWith(
    1,
    ITEM_ID,
    null,
    "cursor-1",
    expect.anything(),
  );
  expect(advanceCursor).toHaveBeenNthCalledWith(
    2,
    ITEM_ID,
    "cursor-1",
    "cursor-2",
    expect.anything(),
  );
  expect(upsertManyFromPlaid).toHaveBeenCalledTimes(2);
  expect(softDeleteByPlaidIds).toHaveBeenCalledWith(
    ["txn-old"],
    USER_ID,
    expect.anything(),
  );
  expect(withUserMutation).toHaveBeenCalledOnce();
});

it("applies rename, hide, and tag-add actions from a matched rule during sync", async () => {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    cursor: null,
    status: "active" as const,
    errorCode: null,
    errorMessage: null,
    accessTokenEncrypted: "encrypted",
    accessTokenNonce: "nonce",
  };
  const page = {
    accounts: [
      {
        account_id: "plaid-account",
        name: "Checking",
        type: "depository",
        subtype: "checking",
        balances: { current: 10, available: 8, iso_currency_code: "USD" },
      },
    ],
    added: [
      {
        transaction_id: "txn-1",
        account_id: "plaid-account",
        amount: 5.5,
        date: "2026-09-09",
        pending: false,
        name: "SQ *STARBUCKS",
        merchant_name: "Starbucks",
      },
    ],
    modified: [],
    removed: [],
    nextCursor: "cursor-1",
    hasMore: false,
    rawPayload: { next_cursor: "cursor-1" },
  };
  const applyRuleMatch = vi.fn(async () => null);
  const addTransactionTags = vi.fn(async () => undefined);
  const service = createPlaidSyncService({
    categorizer: noCategorizer,
    items: {
      findByUuid: vi.fn(async () => item),
      isFeatureEnabled: vi.fn(async () => true),
      advanceCursor: vi.fn(async () => true),
      markSynced: vi.fn(async () => undefined),
      markStatus: vi.fn(async () => undefined),
    },
    client: { syncTransactions: vi.fn(async () => page) },
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: {
      upsertFromPlaid: vi.fn(async () => ({
        id: "33333333-3333-4333-8333-333333333333",
      })),
      findByPlaidAccountIds: vi.fn(async () => []),
    },
    transactions: {
      upsertManyFromPlaid: vi.fn(async () => [
        {
          id: "txn-1",
          merchantName: "Starbucks",
          name: "SQ *STARBUCKS",
          amount: 550n,
          accountId: "acct-1",
          userCategoryOverride: false,
          householdMemberId: null,
          notes: null,
          excludeFromBudgets: false,
          reviewStatus: "needs_review",
          userName: null,
        },
      ]),
      softDeleteByPlaidIds: vi.fn(async () => undefined),
      applyRuleMatch,
      addTransactionTags,
    },
    rules: {
      // Shaped as a real RuleRow (DB row), not a RuleForMatching — this is
      // exactly what listActiveRules actually returns, and the field name
      // is actionAddTags (the DB column), not actionAddTagIds. If the ingest
      // code goes back to `rule as RuleForMatching` instead of routing
      // through `ruleForMatching()`, this test fails because the mismatched
      // field name means the real code would read `undefined`, not ["tag-1"].
      listActiveRules: vi.fn(async () => [
        {
          id: "rule-1",
          userId: USER_ID,
          name: "Starbucks rule",
          priority: 10,
          matchType: "merchant_contains",
          matchMerchant: "Starbucks",
          matchNameContains: null,
          matchAmountMin: null,
          matchAmountMax: null,
          matchAccountId: null,
          actionCategoryId: null,
          actionMemberId: null,
          actionSetNotes: null,
          actionMarkReviewed: null,
          actionExcludeFromBudgets: null,
          actionRename: "Starbucks",
          actionHide: null,
          actionAddTags: ["tag-1"],
          isActive: true,
          applyToExisting: false,
          lastAppliedAt: null,
          timesApplied: 0,
          createdAt: new Date("2026-09-12T00:00:00.000Z"),
          updatedAt: new Date("2026-09-12T00:00:00.000Z"),
        },
      ]),
    },
    rawImports: { record: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) },
    transaction: async (callback: (tx: object) => Promise<unknown>) =>
      callback({}),
    withUserMutation: vi.fn(
      async (_userId: string, callback: (tx: object) => Promise<unknown>) =>
        callback({}),
    ),
  } as never);

  await service.syncItem(USER_ID, ITEM_ID);

  expect(applyRuleMatch).toHaveBeenCalledWith(
    "txn-1",
    USER_ID,
    expect.objectContaining({ userName: "Starbucks" }),
    expect.anything(),
  );
  expect(addTransactionTags).toHaveBeenCalledWith(
    "txn-1",
    USER_ID,
    ["tag-1"],
    expect.anything(),
  );
});

it("applies the hide action from a matched rule during sync", async () => {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    cursor: null,
    status: "active" as const,
    errorCode: null,
    errorMessage: null,
    accessTokenEncrypted: "encrypted",
    accessTokenNonce: "nonce",
  };
  const page = {
    accounts: [
      {
        account_id: "plaid-account",
        name: "Checking",
        type: "depository",
        subtype: "checking",
        balances: { current: 10, available: 8, iso_currency_code: "USD" },
      },
    ],
    added: [
      {
        transaction_id: "txn-1",
        account_id: "plaid-account",
        amount: 5.5,
        date: "2026-09-09",
        pending: false,
        name: "SQ *STARBUCKS",
        merchant_name: "Starbucks",
      },
    ],
    modified: [],
    removed: [],
    nextCursor: "cursor-1",
    hasMore: false,
    rawPayload: { next_cursor: "cursor-1" },
  };
  const applyRuleMatch = vi.fn(async () => null);
  const addTransactionTags = vi.fn(async () => undefined);
  const service = createPlaidSyncService({
    categorizer: noCategorizer,
    items: {
      findByUuid: vi.fn(async () => item),
      isFeatureEnabled: vi.fn(async () => true),
      advanceCursor: vi.fn(async () => true),
      markSynced: vi.fn(async () => undefined),
      markStatus: vi.fn(async () => undefined),
    },
    client: { syncTransactions: vi.fn(async () => page) },
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: {
      upsertFromPlaid: vi.fn(async () => ({
        id: "33333333-3333-4333-8333-333333333333",
      })),
      findByPlaidAccountIds: vi.fn(async () => []),
    },
    transactions: {
      upsertManyFromPlaid: vi.fn(async () => [
        {
          id: "txn-1",
          merchantName: "Starbucks",
          name: "SQ *STARBUCKS",
          amount: 550n,
          accountId: "acct-1",
          userCategoryOverride: false,
          householdMemberId: null,
          notes: null,
          excludeFromBudgets: false,
          reviewStatus: "needs_review",
          userName: null,
        },
      ]),
      softDeleteByPlaidIds: vi.fn(async () => undefined),
      applyRuleMatch,
      addTransactionTags,
    },
    rules: {
      // No rename/tags on this rule — isolates the hide branch of
      // rulePatch() from the rename+tag test above.
      listActiveRules: vi.fn(async () => [
        {
          id: "rule-2",
          userId: USER_ID,
          name: "Hide Starbucks",
          priority: 10,
          matchType: "merchant_contains",
          matchMerchant: "Starbucks",
          matchNameContains: null,
          matchAmountMin: null,
          matchAmountMax: null,
          matchAccountId: null,
          actionCategoryId: null,
          actionMemberId: null,
          actionSetNotes: null,
          actionMarkReviewed: null,
          actionExcludeFromBudgets: null,
          actionRename: null,
          actionHide: true,
          actionAddTags: null,
          isActive: true,
          applyToExisting: false,
          lastAppliedAt: null,
          timesApplied: 0,
          createdAt: new Date("2026-09-12T00:00:00.000Z"),
          updatedAt: new Date("2026-09-12T00:00:00.000Z"),
        },
      ]),
    },
    rawImports: { record: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) },
    transaction: async (callback: (tx: object) => Promise<unknown>) =>
      callback({}),
    withUserMutation: vi.fn(
      async (_userId: string, callback: (tx: object) => Promise<unknown>) =>
        callback({}),
    ),
  } as never);

  await service.syncItem(USER_ID, ITEM_ID);

  expect(applyRuleMatch).toHaveBeenCalledWith(
    "txn-1",
    USER_ID,
    expect.objectContaining({ reviewStatus: "hidden" }),
    expect.anything(),
  );
  expect(addTransactionTags).not.toHaveBeenCalled();
});

it("auto-categorises only newly imported transactions that no rule or user categorised", async () => {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    cursor: null,
    status: "active" as const,
    errorCode: null,
    errorMessage: null,
    accessTokenEncrypted: "encrypted",
    accessTokenNonce: "nonce",
  };
  const txn = (id: string) => ({
    transaction_id: id,
    account_id: "pa",
    amount: 5,
    date: "2026-09-25",
    pending: false,
    name: id,
  });
  const page = {
    accounts: [],
    added: [txn("new"), txn("known"), txn("user-set"), txn("adopted")],
    modified: [],
    removed: [],
    nextCursor: "c1",
    hasMore: false,
    rawPayload: {},
  };
  const now = new Date();
  const row = (plaidId: string, extra: Record<string, unknown> = {}) => ({
    id: `row-${plaidId}`,
    plaidTransactionId: plaidId,
    merchantName: null,
    name: plaidId,
    amount: 500n,
    accountId: "acct",
    categoryId: null,
    userCategoryOverride: false,
    plaidCategoryPrimary: "FOOD_AND_DRINK",
    plaidCategoryDetailed: null,
    createdAt: now,
    ...extra,
  });
  const categorizer = {
    existingPlaidIds: vi.fn(async () => new Set(["known"])),
    categorize: vi.fn(async () => ({ fromHistory: 0, fromBank: 1 })),
  };
  const service = createPlaidSyncService({
    categorizer,
    items: {
      findByUuid: vi.fn(async () => item),
      isFeatureEnabled: vi.fn(async () => true),
      advanceCursor: vi.fn(async () => true),
      markSynced: vi.fn(async () => undefined),
      markStatus: vi.fn(async () => undefined),
    },
    client: { syncTransactions: vi.fn(async () => page) },
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: {
      upsertFromPlaid: vi.fn(async () => ({ id: "acct" })),
      findByPlaidAccountIds: vi.fn(async () => [
        { id: "acct", plaidAccountId: "pa" },
      ]),
    },
    transactions: {
      upsertManyFromPlaid: vi.fn(async () => [
        row("new"),
        row("known"),
        row("user-set", { userCategoryOverride: true, categoryId: "cat" }),
        // History adopted after a relink: a new Plaid id on an old row.
        row("adopted", { createdAt: new Date("2026-06-01T00:00:00Z") }),
      ]),
      softDeleteByPlaidIds: vi.fn(async () => undefined),
    },
    rules: { listActiveRules: vi.fn(async () => []) },
    rawImports: { record: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) },
    transaction: async (callback: (tx: object) => Promise<unknown>) =>
      callback({}),
    withUserMutation: vi.fn(
      async (_u: string, cb: (tx: object) => Promise<unknown>) => cb({}),
    ),
  } as never);

  await service.syncItem(USER_ID, ITEM_ID);

  expect(categorizer.existingPlaidIds).toHaveBeenCalledWith(
    ["new", "known", "user-set", "adopted"],
    USER_ID,
    expect.anything(),
  );
  expect(categorizer.categorize).toHaveBeenCalledTimes(1);
  const [, rows] = categorizer.categorize.mock.calls[0] as unknown as [
    string,
    Array<{ id: string }>,
  ];
  expect(rows.map((r) => r.id)).toEqual(["row-new"]);
});
