import { expect, it, vi } from "vitest";
import { createPlaidSyncService } from "../plaid-sync.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

it("applies every sync page, advances the cursor, and publishes one mutation", async () => {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    cursor: null,
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
