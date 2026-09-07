import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  budgetsRepository,
  createBudgetRepository,
  type BudgetRepository,
  type BudgetDb,
} from "../budgets.repository.js";
import type { DbTransaction } from "../../../platform/database/types.js";

function transactionLike() {
  const transaction = vi.fn();
  const where = vi.fn(async () => []);
  const set = vi.fn(() => ({ where }));
  const returning = vi.fn(async () => [{ id: "budget-id" }]);
  const values = vi.fn(() => ({ returning }));
  return {
    transaction,
    update: vi.fn(() => ({ set })),
    delete: vi.fn(() => ({ where })),
    insert: vi.fn(() => ({ values })),
  } as unknown as DbTransaction & { transaction: ReturnType<typeof vi.fn> };
}

describe("budget repository boundaries", () => {
  it("does not wrap a transaction-like database that exposes transaction", async () => {
    const transactionLikeDb = transactionLike();

    await expect(
      budgetsRepository.createBudget(
        "11111111-1111-4111-8111-111111111111",
        { items: [] },
        transactionLikeDb,
      ),
    ).resolves.toMatchObject({ id: "budget-id" });
    expect(transactionLikeDb.transaction).not.toHaveBeenCalled();
  });

  it("does not wrap a transaction-like database when replacing items", async () => {
    const transactionLikeDb = transactionLike();

    await expect(
      budgetsRepository.replaceBudgetItems(
        "11111111-1111-4111-8111-111111111111",
        [],
        transactionLikeDb,
      ),
    ).resolves.toBeUndefined();
    expect(transactionLikeDb.transaction).not.toHaveBeenCalled();
  });

  it("does not wrap a transaction-like database when upserting an item", async () => {
    const transactionLikeDb = transactionLike();

    await expect(
      budgetsRepository.upsertBudgetItem(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        500n,
        transactionLikeDb,
      ),
    ).resolves.toMatchObject({ id: "budget-id" });
    expect(transactionLikeDb.transaction).not.toHaveBeenCalled();
  });

  it("exposes transaction-only parameters for direct budget mutations", () => {
    type CreateDatabase = Parameters<BudgetRepository["createBudget"]>[2];
    type ReplaceDatabase = Parameters<
      BudgetRepository["replaceBudgetItems"]
    >[2];
    type UpsertDatabase = Parameters<BudgetRepository["upsertBudgetItem"]>[3];

    expectTypeOf<CreateDatabase>().toEqualTypeOf<DbTransaction | undefined>();
    expectTypeOf<ReplaceDatabase>().toEqualTypeOf<DbTransaction | undefined>();
    expectTypeOf<UpsertDatabase>().toEqualTypeOf<DbTransaction | undefined>();
  });

  it("forwards the supplied transaction to active-budget reads", async () => {
    const root = { root: true } as unknown as BudgetDb;
    const transaction = { transaction: true } as unknown as BudgetDb;
    const spy = vi
      .spyOn(budgetsRepository, "getActiveBudget")
      .mockResolvedValue(null);

    try {
      await createBudgetRepository(root as never).getActiveBudget(
        "11111111-1111-4111-8111-111111111111",
        transaction,
      );
      expect(spy).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        transaction,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
