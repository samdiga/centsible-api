import { describe, expect, it } from "vitest";

import { createBudgetRepository } from "../../../src/modules/budgets/budgets.repository.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";
import { seedSplitUser } from "./splits-fixtures.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

guardedDescribe("bank sync and splits (T-186)", () => {
  it("adjusts the remainder, flags a sign flip, and clears the flag when the amount returns", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const repo = createTransactionRepository(db);
      const budgetsRepo = createBudgetRepository(db);
      const plaidId = "plaid-dinner";
      const dinner = await seed.insertTransaction(30000n, {
        plaidTransactionId: plaidId,
        categoryId: seed.owed.id,
        userCategoryOverride: true,
      });
      await seed.insertLines(dinner.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);
      const sync = async (dollars: number) => {
        const saved = await repo.upsertManyFromPlaid([
          {
            userId: seed.userId,
            accountId: seed.checking.id,
            txn: {
              transaction_id: plaidId,
              account_id: "plaid-account",
              amount: dollars,
              date: "2026-11-02",
              name: "Dinner",
              pending: false,
              personal_finance_category: {
                primary: "FOOD_AND_DRINK",
                detailed: "FOOD_AND_DRINK_RESTAURANT",
              },
            },
          },
        ]);
        await repo.rebalanceSplits(
          seed.userId,
          saved.map((row) => row.id),
        );
        return (await repo.findById(dinner.id, seed.userId))!;
      };
      const lines = async () =>
        (await repo.listSplitLines(seed.userId, [dinner.id]))
          .get(dinner.id)!
          .map((l) => l.amount);
      const usage = async () =>
        new Map(
          (
            await budgetsRepo.getUsageSpend(
              seed.userId,
              "2026-11-01",
              "2026-11-30",
              {
                accountIds: [],
                categoryIds: [],
                tagIds: [],
              },
            )
          ).map((row) => [row.categoryId, row.spentCents]),
        );

      const tipped = await sync(320);
      expect(tipped.amount).toBe(32000n);
      expect(tipped.splitOutOfBalance).toBe(false);
      expect(tipped.categoryId).toBe(seed.owed.id);
      expect(await lines()).toEqual([10000n, 22000n]);

      const flipped = await sync(-50);
      expect(flipped.splitOutOfBalance).toBe(true);
      expect(flipped.categoryId).toBe(seed.owed.id);
      expect(await lines()).toEqual([10000n, 22000n]);
      const flippedUsage = await usage();
      expect(flippedUsage.get(seed.restaurants.id)).toBeUndefined();
      expect(flippedUsage.get(seed.owed.id)).toBe(-5000n);

      const back = await sync(320);
      expect(back.splitOutOfBalance).toBe(false);
      expect((await usage()).get(seed.restaurants.id)).toBe(10000n);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
