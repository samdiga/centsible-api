import { describe, expect, it, vi } from "vitest";

import { createResponseCache } from "../../../platform/cache/response-cache.js";
import {
  NotFoundError,
  ValidationError,
} from "../../../platform/errors/app-error.js";
import type { DbTransaction } from "../../../platform/database/types.js";
import type {
  ManualAccountForWrite,
  ManualTransactionRepository,
} from "../manual-transactions.repository.js";
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
    findByIdForUpdate: vi.fn(async () => row as TransactionRow),
    listSimilarByMerchant: vi.fn(async () => [row]),
    updateTransaction: vi.fn(
      async () => ({ ...row, notes: "updated" }) as TransactionRow,
    ),
    softDeleteTransaction: vi.fn(async () => ({
      ...row,
      deletedAt: new Date(),
      status: "removed",
    }) as TransactionRow),
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
    expect(repo.findByIdForUpdate).toHaveBeenCalledWith(TRANSACTION_ID, USER_ID, {
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
    vi.mocked(repo.findByIdForUpdate).mockResolvedValue(null);
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

  describe("createManualTransaction", () => {
    const ACCOUNT_ID = "77777777-7777-4777-8777-777777777777";
    const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const body = {
      accountId: ACCOUNT_ID,
      amount: "1250",
      date: "2026-09-20",
      name: "Farmers market",
    };
    const inserted = {
      ...row,
      accountId: ACCOUNT_ID,
      plaidTransactionId: null,
      amount: 1250n,
      name: "Farmers market",
      merchantName: null,
      householdMemberId: null,
      excludeFromBudgets: false,
    } as unknown as TransactionRow;

    function manualRepo(
      overrides: Partial<ManualTransactionRepository> = {},
    ): ManualTransactionRepository {
      return {
        claimIdempotencyKey: vi.fn(async () => true),
        findIdempotencyKey: vi.fn(async () => null),
        completeIdempotencyKey: vi.fn(async () => undefined),
        findAccountForWrite: vi.fn(async () => ({
          id: ACCOUNT_ID,
          subtype: "checking",
          currency: "USD",
          isManual: true,
          archivedAt: null,
        })),
        insertManualTransaction: vi.fn(async () => inserted),
        adjustAccountBalance: vi.fn(async () => 8750n),
        ...overrides,
      };
    }
    function setup(overrides: Partial<ManualTransactionRepository> = {}) {
      const repo = repository();
      vi.mocked(repo.findById).mockResolvedValue(inserted);
      vi.mocked(repo.findByIdForUpdate).mockResolvedValue(inserted);
      const manual = manualRepo(overrides);
      const rules = { listActiveRules: vi.fn(async () => []) };
      const service = createTransactionService({
        repository: repo,
        manualRepository: manual,
        rules,
        withUserMutation: async (_userId, callback) =>
          callback({} as DbTransaction),
      });
      return { repo, manual, rules, service };
    }

    it("reverses and reapplies a manual transaction balance when edited and moved", async () => {
      const checking = {
        id: ACCOUNT_ID,
        subtype: "checking",
        currency: "USD",
        isManual: true,
        archivedAt: null,
      };
      const card = {
        id: "88888888-8888-4888-8888-888888888888",
        subtype: "credit_card",
        currency: "USD",
        isManual: true,
        archivedAt: null,
      };
      const { manual, service } = setup({
        findAccountForWrite: vi.fn(async (_userId, accountId) =>
          accountId === card.id ? card : checking,
        ),
      });

      await service.patchTransaction(USER_ID, inserted.id, {
        amount: 2000n,
        accountId: card.id,
      } as never);

      expect(manual.adjustAccountBalance).toHaveBeenNthCalledWith(
        1,
        USER_ID,
        ACCOUNT_ID,
        1250n,
        expect.anything(),
      );
      expect(manual.adjustAccountBalance).toHaveBeenNthCalledWith(
        2,
        USER_ID,
        card.id,
        2000n,
        expect.anything(),
      );
    });

    it("rejects moving a transaction to an account with a different currency", async () => {
      const target = {
        id: "88888888-8888-4888-8888-888888888888",
        subtype: "checking",
        currency: "EUR",
        isManual: true,
        archivedAt: null,
      };
      const { manual, service } = setup({
        findAccountForWrite: vi.fn(async (_userId, accountId) =>
          accountId === target.id
            ? target
            : {
                id: ACCOUNT_ID,
                subtype: "checking",
                currency: "USD",
                isManual: true,
                archivedAt: null,
              },
        ),
      });

      await expect(
        service.patchTransaction(USER_ID, inserted.id, {
          accountId: target.id,
        } as never),
      ).rejects.toMatchObject({ httpStatus: 422 });
      expect(manual.adjustAccountBalance).not.toHaveBeenCalled();
    });

    it("rejects financial edits to synced transactions", async () => {
      const { repo, manual, service } = setup();
      vi.mocked(repo.findByIdForUpdate).mockResolvedValue({
        ...inserted,
        plaidTransactionId: "plaid-transaction",
      });

      await expect(
        service.patchTransaction(USER_ID, inserted.id, { amount: 2000n } as never),
      ).rejects.toMatchObject({ httpStatus: 422 });
      expect(manual.adjustAccountBalance).not.toHaveBeenCalled();
    });

    it("deletes a manual transaction and reverses its balance in the same mutation", async () => {
      const { repo, manual, service } = setup();

      await service.deleteManualTransaction(USER_ID, inserted.id);

      expect(manual.adjustAccountBalance).toHaveBeenCalledWith(
        USER_ID,
        ACCOUNT_ID,
        1250n,
        expect.anything(),
      );
      expect(repo.softDeleteTransaction).toHaveBeenCalledWith(
        inserted.id,
        USER_ID,
        expect.anything(),
      );
      expect(repo.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "delete",
          source: "transactions.manual_delete",
        }),
        expect.anything(),
      );
    });

    it("rejects deleting when the transaction and account currencies differ", async () => {
      const { manual, service } = setup({
        findAccountForWrite: vi.fn(async () => ({
          id: ACCOUNT_ID,
          subtype: "checking",
          currency: "EUR",
          isManual: true,
          archivedAt: null,
        })),
      });

      await expect(
        service.deleteManualTransaction(USER_ID, inserted.id),
      ).rejects.toMatchObject({ httpStatus: 422 });
      expect(manual.adjustAccountBalance).not.toHaveBeenCalled();
    });

    it("rejects deletion of synced transactions and archived manual accounts", async () => {
      const linked = setup();
      vi.mocked(linked.repo.findByIdForUpdate).mockResolvedValue({
        ...inserted,
        plaidTransactionId: "plaid-transaction",
      });
      await expect(
        linked.service.deleteManualTransaction(USER_ID, inserted.id),
      ).rejects.toMatchObject({ httpStatus: 422 });

      const archived = setup({
        findAccountForWrite: vi.fn(async () => ({
          id: ACCOUNT_ID,
          subtype: "checking",
          currency: "USD",
          isManual: true,
          archivedAt: new Date(),
        })),
      });
      await expect(
        archived.service.deleteManualTransaction(USER_ID, inserted.id),
      ).rejects.toMatchObject({ httpStatus: 409 });
      expect(archived.manual.adjustAccountBalance).not.toHaveBeenCalled();
    });

    it("inserts, moves a checking balance down by an outflow, and stores the response under the key", async () => {
      const { manual, rules, repo, service } = setup();

      const result = await service.createManualTransaction(USER_ID, KEY, body);

      expect(result.replayed).toBe(false);
      expect(result.transaction.isManual).toBe(true);
      expect(manual.adjustAccountBalance).toHaveBeenCalledWith(
        USER_ID,
        ACCOUNT_ID,
        -1250n,
        expect.anything(),
      );
      expect(rules.listActiveRules).toHaveBeenCalled();
      expect(manual.completeIdempotencyKey).toHaveBeenCalledWith(
        USER_ID,
        KEY,
        inserted.id,
        result.transaction,
        expect.anything(),
      );
      expect(repo.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ source: "transactions.manual_create" }),
        expect.anything(),
      );
    });

    it("keeps a picked category and skips rules", async () => {
      const { manual, rules, service } = setup();
      const categoryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

      await service.createManualTransaction(USER_ID, KEY, {
        ...body,
        categoryId,
      });

      expect(manual.insertManualTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId }),
        expect.anything(),
      );
      expect(rules.listActiveRules).not.toHaveBeenCalled();
    });

    it("replays the stored response for the same key and body without writing", async () => {
      const first = await setup().service.createManualTransaction(
        USER_ID,
        KEY,
        body,
      );
      let storedHash = "";
      const { manual, service } = setup({
        claimIdempotencyKey: vi.fn(async (_u, _k, hash: string) => {
          storedHash = hash;
          return false;
        }),
        findIdempotencyKey: vi.fn(async () => ({
          requestHash: storedHash,
          response: first.transaction,
        })),
      });

      const result = await service.createManualTransaction(USER_ID, KEY, body);

      expect(result).toEqual({
        transaction: first.transaction,
        replayed: true,
      });
      expect(manual.insertManualTransaction).not.toHaveBeenCalled();
      expect(manual.adjustAccountBalance).not.toHaveBeenCalled();
    });

    it("rejects the same key with a different body with 422", async () => {
      const { service } = setup({
        claimIdempotencyKey: vi.fn(async () => false),
        findIdempotencyKey: vi.fn(async () => ({
          requestHash: "different",
          response: {},
        })),
      });

      await expect(
        service.createManualTransaction(USER_ID, KEY, body),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
        httpStatus: 422,
      });
    });

    it("rejects linked (422), archived (409) and missing (404) accounts", async () => {
      const account: ManualAccountForWrite = {
        id: ACCOUNT_ID,
        subtype: "checking",
        currency: "USD",
        isManual: true,
        archivedAt: null,
      };
      const attempt = (value: ManualAccountForWrite | null) =>
        setup({
          findAccountForWrite: vi.fn(async () => value),
        }).service.createManualTransaction(USER_ID, KEY, body);

      await expect(
        attempt({ ...account, isManual: false }),
      ).rejects.toMatchObject({ httpStatus: 422 });
      await expect(
        attempt({ ...account, archivedAt: new Date() }),
      ).rejects.toMatchObject({ httpStatus: 409 });
      await expect(attempt(null)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it("raises a credit card's owed balance on a purchase and refuses to take it below zero", async () => {
      const card = {
        id: ACCOUNT_ID,
        subtype: "credit_card",
        currency: "USD",
        isManual: true,
        archivedAt: null,
      };
      const ok = setup({ findAccountForWrite: vi.fn(async () => card) });
      await ok.service.createManualTransaction(USER_ID, KEY, body);
      expect(ok.manual.adjustAccountBalance).toHaveBeenCalledWith(
        USER_ID,
        ACCOUNT_ID,
        1250n,
        expect.anything(),
      );

      const overpaid = setup({
        findAccountForWrite: vi.fn(async () => card),
        adjustAccountBalance: vi.fn(async () => -1n),
      });
      await expect(
        overpaid.service.createManualTransaction(USER_ID, KEY, {
          ...body,
          amount: "-99999",
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });
      expect(overpaid.manual.completeIdempotencyKey).not.toHaveBeenCalled();
    });
  });
});
