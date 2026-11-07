import { describe, expect, it } from "vitest";

import { createCategoryRepository } from "../../../src/modules/categories/categories.repository.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";
import { seedSplitUser } from "../transactions/splits-fixtures.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

guardedDescribe("category moves carry split lines (T-186)", () => {
  it("moves lines, merges lines that now share a category, and re-derives the category", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const categoriesRepo = createCategoryRepository(db);
      const transactionsRepo = createTransactionRepository(db);
      const amounts = async (id: string) =>
        (await transactionsRepo.listSplitLines(seed.userId, [id]))
          .get(id)
          ?.map((line) => [line.categoryId, line.amount, line.isRemainder]);

      const brunch = await seed.insertTransaction(30000n, {
        categoryId: seed.owed.id,
      });
      await seed.insertLines(brunch.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.coffee.id, amount: 6000n, isRemainder: true },
        { categoryId: seed.owed.id, amount: 14000n },
      ]);
      // Archive Coffee into Restaurants: Restaurants is now 16000, the largest.
      await db.transaction((tx) =>
        categoriesRepo.moveReferences(
          seed.userId,
          seed.coffee.id,
          seed.restaurants.id,
          tx,
        ),
      );
      expect(await amounts(brunch.id)).toEqual([
        [seed.restaurants.id, 16000n, true],
        [seed.owed.id, 14000n, false],
      ]);
      expect(
        (await transactionsRepo.findById(brunch.id, seed.userId))!.categoryId,
      ).toBe(seed.restaurants.id);

      // A two-line split whose lines both land on one category is unsplit.
      const lunch = await seed.insertTransaction(5000n, {
        categoryId: seed.owed.id,
      });
      await seed.insertLines(lunch.id, [
        { categoryId: seed.restaurants.id, amount: 2000n },
        { categoryId: seed.owed.id, amount: 3000n, isRemainder: true },
      ]);
      await db.transaction((tx) =>
        categoriesRepo.moveReferences(
          seed.userId,
          seed.owed.id,
          seed.restaurants.id,
          tx,
        ),
      );
      expect(await amounts(lunch.id)).toBeUndefined();
      const lunchRow = (await transactionsRepo.findById(
        lunch.id,
        seed.userId,
      ))!;
      expect(lunchRow.categoryId).toBe(seed.restaurants.id);
      expect(lunchRow.splitOutOfBalance).toBe(false);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("never offers a split transaction to recategorise-similar", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const transactionsRepo = createTransactionRepository(db);
      const edited = await seed.insertTransaction(1500n, {
        name: "Blue Bottle",
        categoryId: seed.coffee.id,
      });
      const plain = await seed.insertTransaction(1200n, {
        name: "Blue Bottle",
      });
      const split = await seed.insertTransaction(3000n, {
        name: "Blue Bottle",
        categoryId: seed.owed.id,
      });
      await seed.insertLines(split.id, [
        { categoryId: seed.coffee.id, amount: 1000n },
        { categoryId: seed.owed.id, amount: 2000n, isRemainder: true },
      ]);
      const similar = await transactionsRepo.listSimilarByMerchant({
        userId: seed.userId,
        transactionId: edited.id,
        limit: 100,
      });
      expect(similar!.map((row) => row.id)).toEqual([plain.id]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
