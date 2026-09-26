import { describe, expect, it, vi } from "vitest";

import { createResponseCache } from "../../../platform/cache/response-cache.js";
import {
  NotFoundError,
  ValidationError,
} from "../../../platform/errors/app-error.js";
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
    listSimilarByMerchant: vi.fn(async () => [row]),
    updateTransaction: vi.fn(
      async () => ({ ...row, notes: "updated" }) as TransactionRow,
    ),
    applyRuleMatch: vi.fn(),
    bulkUpdateTransactions: vi.fn(async () => 1),
    listAllForExport: vi.fn(async () => ({ rows: [], truncated: false })),
    categoryExists: vi.fn(async () => true),
    householdMemberExists: vi.fn(async () => true),
    tagsExist: vi.fn(async () => true),
    getTagIdsForTransactions: vi.fn(async () => new Map()),
    replaceTransactionTags: vi.fn(async () => undefined),
    replaceTransactionTagsForMany: vi.fn(async () => undefined),
    addTransactionTags: vi.fn(async () => undefined),
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

  it("replaces a transaction's tags inside the same mutation and returns the fresh set", async () => {
    const repo = repository();
    vi.mocked(repo.getTagIdsForTransactions).mockResolvedValue(
      new Map([[TRANSACTION_ID, ["tag-1", "tag-2"]]]),
    );
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({ marker: "tx" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await expect(
      service.patchTransaction(USER_ID, TRANSACTION_ID, {
        tagIds: ["tag-1", "tag-2"],
      }),
    ).resolves.toMatchObject({ tagIds: ["tag-1", "tag-2"] });

    expect(repo.replaceTransactionTags).toHaveBeenCalledWith(
      TRANSACTION_ID,
      ["tag-1", "tag-2"],
      { marker: "tx" },
    );
  });

  it("does not touch tags when tagIds is absent from the patch", async () => {
    const repo = repository();
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({ marker: "tx" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await service.patchTransaction(USER_ID, TRANSACTION_ID, { notes: "hi" });

    expect(repo.replaceTransactionTags).not.toHaveBeenCalled();
  });

  it("rejects a patch that references a tag the user doesn't own", async () => {
    const repo = repository();
    vi.mocked(repo.tagsExist).mockResolvedValue(false);
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({ marker: "tx" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await expect(
      service.patchTransaction(USER_ID, TRANSACTION_ID, {
        tagIds: ["foreign-tag"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repo.updateTransaction).not.toHaveBeenCalled();
  });

  it("allows clearing every tag with an empty array without an ownership check", async () => {
    const repo = repository();
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({ marker: "tx" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await service.patchTransaction(USER_ID, TRANSACTION_ID, { tagIds: [] });

    expect(repo.tagsExist).not.toHaveBeenCalled();
    expect(repo.replaceTransactionTags).toHaveBeenCalledWith(
      TRANSACTION_ID,
      [],
      {
        marker: "tx",
      },
    );
  });

  it("replaces tags for every row in a bulk patch that includes tagIds", async () => {
    const repo = repository();
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({ marker: "tx" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await service.bulkPatchTransactions(USER_ID, {
      ids: [TRANSACTION_ID, "another-id"],
      patch: { tagIds: ["tag-1"] },
    });

    expect(repo.replaceTransactionTagsForMany).toHaveBeenCalledWith(
      [TRANSACTION_ID, "another-id"],
      ["tag-1"],
      { marker: "tx" },
    );
  });

  it("captures the before/after tag id sets in the audit payload for a tag-only patch", async () => {
    const repo = repository();
    vi.mocked(repo.updateTransaction).mockResolvedValue(row as TransactionRow);
    vi.mocked(repo.getTagIdsForTransactions)
      .mockResolvedValueOnce(new Map([[TRANSACTION_ID, ["tag-old"]]]))
      .mockResolvedValueOnce(new Map([[TRANSACTION_ID, ["tag-new"]]]));
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({ marker: "tx" } as never),
    );
    const service = createTransactionService({
      repository: repo,
      withUserMutation,
    });

    await service.patchTransaction(USER_ID, TRANSACTION_ID, {
      tagIds: ["tag-new"],
    });

    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ tagIds: ["tag-old"] }),
        after: expect.objectContaining({ tagIds: ["tag-new"] }),
      }),
      { marker: "tx" },
    );
  });

  it("attaches batched tagIds to every row in a list page", async () => {
    const repo = repository();
    vi.mocked(repo.getTagIdsForTransactions).mockResolvedValue(
      new Map([[TRANSACTION_ID, ["tag-1"]]]),
    );
    const service = createTransactionService({
      repository: repo,
      getUserRevision: async () => 1n,
    });

    const page = await service.listTransactions(USER_ID, { limit: 2 });

    expect(page.transactions[0]).toMatchObject({ tagIds: ["tag-1"] });
    expect(repo.getTagIdsForTransactions).toHaveBeenCalledWith(USER_ID, [
      TRANSACTION_ID,
    ]);
  });

  it("lists similar transactions with their tags, bounded, and 404s an unknown one", async () => {
    const repo = repository();
    vi.mocked(repo.getTagIdsForTransactions).mockResolvedValue(
      new Map([[row.id, ["tag-1"]]]),
    );
    const service = createTransactionService({ repository: repo });

    const similar = await service.listSimilarTransactions(USER_ID, "edited-id");

    expect(repo.listSimilarByMerchant).toHaveBeenCalledWith({
      userId: USER_ID,
      transactionId: "edited-id",
      limit: 100,
    });
    expect(similar).toEqual([
      expect.objectContaining({ id: row.id, tagIds: ["tag-1"] }),
    ]);

    vi.mocked(repo.listSimilarByMerchant).mockResolvedValueOnce(null);
    await expect(
      service.listSimilarTransactions(USER_ID, "missing-id"),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});
