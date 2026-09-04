import { describe, expect, it, vi } from "vitest";

import { createResponseCache } from "../../../platform/cache/response-cache.js";
import { NotFoundError } from "../../../platform/errors/app-error.js";
import { createTransactionService } from "../transactions.service.js";
import type {
  TransactionListRow,
  TransactionRepository,
  TransactionRow,
} from "../transactions.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";

const row: TransactionListRow = {
  id: TRANSACTION_ID,
  plaidTransactionId: "plaid-transaction",
  accountId: "33333333-3333-4333-8333-333333333333",
  amount: 1250n,
  currency: "USD",
  date: "2026-09-04",
  status: "posted",
  name: "Coffee",
  merchantName: "Cafe",
  paymentChannel: "in store",
  plaidCategoryPrimary: "FOOD_AND_DRINK",
  plaidCategoryDetailed: "FOOD_AND_DRINK_COFFEE",
  categoryId: null,
  userCategoryOverride: false,
  isRecurring: false,
  reviewStatus: "needs_review",
  userName: null,
  notes: null,
};

function repository(): TransactionRepository {
  return {
    upsertFromPlaid: vi.fn(),
    upsertManyFromPlaid: vi.fn(),
    softDeleteByPlaidIds: vi.fn(),
    findByPlaidId: vi.fn(),
    listByUser: vi.fn(async () => ({ rows: [row], nextCursor: "cursor" })),
    findById: vi.fn(async () => row as TransactionRow),
    updateTransaction: vi.fn(
      async () => ({ ...row, notes: "updated" }) as TransactionRow,
    ),
    bulkUpdateTransactions: vi.fn(async () => 1),
    listAllForExport: vi.fn(async () => ({ rows: [], truncated: false })),
    categoryExists: vi.fn(async () => true),
    householdMemberExists: vi.fn(async () => true),
    recordAudit: vi.fn(async () => undefined),
  };
}

describe("transactions service", () => {
  it("caches only the first page and always reads a cursor page", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const service = createTransactionService({
      repository: repo,
      cache,
      getUserRevision: async () => 1n,
    });

    await service.listTransactions(USER_ID, { limit: 2 });
    await service.listTransactions(USER_ID, { limit: 2 });
    await service.listTransactions(USER_ID, { limit: 2, cursor: "cursor" });

    expect(repo.listByUser).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("uses one user mutation for a patch and records its before-and-after audit", async () => {
    const repo = repository();
    const withUserMutation = vi.fn(async (_userId, callback) =>
      callback({ marker: "transaction" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await expect(
      service.patchTransaction(USER_ID, TRANSACTION_ID, {
        notes: "updated",
        categoryId: "44444444-4444-4444-8444-444444444444",
      }),
    ).resolves.toMatchObject({ notes: "updated" });

    expect(withUserMutation).toHaveBeenCalledTimes(1);
    expect(repo.categoryExists).toHaveBeenCalledWith(
      USER_ID,
      "44444444-4444-4444-8444-444444444444",
      { marker: "transaction" },
    );
    expect(repo.findById).toHaveBeenCalledWith(TRANSACTION_ID, USER_ID, {
      marker: "transaction",
    });
    expect(repo.updateTransaction).toHaveBeenCalledWith(
      TRANSACTION_ID,
      USER_ID,
      {
        notes: "updated",
        categoryId: "44444444-4444-4444-8444-444444444444",
      },
      { marker: "transaction" },
    );
    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: TRANSACTION_ID,
        source: "transactions.patch",
      }),
      { marker: "transaction" },
    );
  });

  it("uses one user mutation for bulk preconditions, update, and audit", async () => {
    const repo = repository();
    const withUserMutation = vi.fn(async (_userId, callback) =>
      callback({ marker: "bulk" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await expect(
      service.bulkPatchTransactions(USER_ID, {
        ids: [TRANSACTION_ID],
        patch: { categoryId: null },
      }),
    ).resolves.toBe(1);

    expect(withUserMutation).toHaveBeenCalledTimes(1);
    expect(repo.bulkUpdateTransactions).toHaveBeenCalledWith(
      [TRANSACTION_ID],
      USER_ID,
      { categoryId: null },
      { marker: "bulk" },
    );
  });

  it("rejects a transaction outside the user scope from inside one mutation", async () => {
    const repo = repository();
    vi.mocked(repo.findById).mockResolvedValue(null);
    const withUserMutation = vi.fn(async (_userId, callback) =>
      callback({ marker: "missing" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await expect(
      service.patchTransaction(USER_ID, TRANSACTION_ID, { notes: "updated" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(withUserMutation).toHaveBeenCalledTimes(1);
  });
});
