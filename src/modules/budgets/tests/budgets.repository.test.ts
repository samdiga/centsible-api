import { describe, expect, it, vi } from "vitest";

import {
  budgetsRepository,
  createBudgetRepository,
  type BudgetDb,
} from "../budgets.repository.js";

describe("budget repository boundaries", () => {
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
