import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { categories } from "../../../database/schema/index.js";
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

const noFilters = { accountIds: [], categoryIds: [], tagIds: [] };
const byCategory = (rows: { categoryId: string | null; spentCents: bigint }[]) =>
  new Map(rows.map((row) => [row.categoryId, row.spentCents]));

guardedDescribe("split lines in budgets and lists (T-186)", () => {
  it("counts each line under its own category, once", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const budgetsRepo = createBudgetRepository(db);
      const transactionsRepo = createTransactionRepository(db);
      const [food] = await db
        .insert(categories)
        .values({ userId: seed.userId, name: "Food" })
        .returning();
      await db
        .update(categories)
        .set({ parentId: food!.id })
        .where(inArray(categories.id, [seed.restaurants.id, seed.coffee.id]));

      const dinner = await seed.insertTransaction(30000n, {
        categoryId: seed.owed.id,
        userCategoryOverride: true,
      });
      await seed.insertLines(dinner.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);
      const brunch = await seed.insertTransaction(6000n, {
        categoryId: seed.restaurants.id,
      });
      await seed.insertLines(brunch.id, [
        { categoryId: seed.restaurants.id, amount: 4000n },
        { categoryId: seed.coffee.id, amount: 1500n },
        { categoryId: null, amount: 500n, isRemainder: true },
      ]);
      await seed.insertTransaction(2500n, { categoryId: seed.coffee.id });

      const usage = byCategory(
        await budgetsRepo.getUsageSpend(
          seed.userId,
          "2026-11-01",
          "2026-11-30",
          noFilters,
        ),
      );
      expect(usage.get(seed.restaurants.id)).toBe(14000n);
      expect(usage.get(seed.coffee.id)).toBe(4000n);
      expect(usage.get(seed.owed.id)).toBe(20000n);
      expect(usage.get(null)).toBe(500n);

      const spent = byCategory(
        await budgetsRepo.getSpentByCategory(seed.userId, "2026-11-01", "2026-11-30"),
      );
      expect(spent.get(seed.restaurants.id)).toBe(14000n);
      expect(spent.get(seed.owed.id)).toBe(20000n);

      // Invariant: the lines add up to the transactions, uncategorised included.
      const total = [...usage.values()].reduce((sum, value) => sum + value, 0n);
      expect(total).toBe(30000n + 6000n + 2500n);

      // A group filter finds the brunch once, with both of its Food lines.
      const foodList = await transactionsRepo.listByUser({
        userId: seed.userId,
        limit: 50,
        filters: { categoryIds: [food!.id], includeChildren: true },
      });
      const foodAmounts = new Map(foodList.rows.map((row) => [row.id, row.filteredAmount]));
      expect(foodList.rows.filter((row) => row.id === brunch.id)).toHaveLength(1);
      expect(foodAmounts.get(brunch.id)).toBe(5500n);
      expect(foodAmounts.get(dinner.id)).toBe(10000n);

      // The budget drill-in for Restaurants shows the dinner as its part.
      const drill = await transactionsRepo.listByUser({
        userId: seed.userId,
        limit: 50,
        filters: { categoryIds: [seed.restaurants.id], budget: true },
      });
      expect(new Map(drill.rows.map((row) => [row.id, row.filteredAmount]))).toEqual(
        new Map([
          [dinner.id, 10000n],
          [brunch.id, 4000n],
        ]),
      );

      const uncategorised = await transactionsRepo.listByUser({
        userId: seed.userId,
        limit: 50,
        filters: { uncategorized: true },
      });
      expect(uncategorised.rows.map((row) => [row.id, row.filteredAmount])).toEqual([
        [brunch.id, 500n],
      ]);

      const unfiltered = await transactionsRepo.listByUser({
        userId: seed.userId,
        limit: 50,
        filters: {},
      });
      expect(unfiltered.rows).toHaveLength(3);
      expect(unfiltered.rows.every((row) => row.filteredAmount === undefined)).toBe(true);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("drops a whole split for transaction-level exclusions and counts a flagged split under its category", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const budgetsRepo = createBudgetRepository(db);
      const [transfer] = await db
        .insert(categories)
        .values({ userId: seed.userId, name: "Transfer", isTransfer: true })
        .returning();

      const excluded = await seed.insertTransaction(30000n, {
        categoryId: seed.owed.id,
        excludeFromBudgets: true,
      });
      await seed.insertLines(excluded.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);
      // A Transfer line is left out; the transaction's other line counts.
      const mixed = await seed.insertTransaction(9000n, { categoryId: transfer!.id });
      await seed.insertLines(mixed.id, [
        { categoryId: transfer!.id, amount: 7000n },
        { categoryId: seed.coffee.id, amount: 2000n, isRemainder: true },
      ]);
      // The bank changed 30000 to 32000 and the split was flagged: the whole
      // charge counts under the stored (largest line's) category.
      const flagged = await seed.insertTransaction(32000n, {
        categoryId: seed.owed.id,
        splitOutOfBalance: true,
      });
      await seed.insertLines(flagged.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);

      const usage = byCategory(
        await budgetsRepo.getUsageSpend(seed.userId, "2026-11-01", "2026-11-30", noFilters),
      );
      expect(usage.get(seed.restaurants.id)).toBeUndefined();
      expect(usage.get(seed.coffee.id)).toBe(2000n);
      expect(usage.get(transfer!.id)).toBeUndefined();
      expect(usage.get(seed.owed.id)).toBe(32000n);

      // Owed to me left out of budgets: the flagged charge drops out entirely.
      await db
        .update(categories)
        .set({ excludeFromBudgets: true })
        .where(eq(categories.id, seed.owed.id));
      const leftOut = byCategory(
        await budgetsRepo.getUsageSpend(seed.userId, "2026-11-01", "2026-11-30", noFilters),
      );
      expect(leftOut.get(seed.owed.id)).toBeUndefined();
      expect(leftOut.get(seed.restaurants.id)).toBeUndefined();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("takes budget suggestions' medians from lines", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const today = new Date().toISOString().slice(0, 10);
      const dinner = await seed.insertTransaction(30000n, {
        categoryId: seed.owed.id,
        date: today,
      });
      await seed.insertLines(dinner.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);
      const medians = new Map(
        (await createBudgetRepository(db).getCategoryMedians(seed.userId)).map((row) => [
          row.categoryId,
          row.medianCents,
        ]),
      );
      expect(medians.get(seed.restaurants.id)).toBe(10000n);
      expect(medians.get(seed.owed.id)).toBe(20000n);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
