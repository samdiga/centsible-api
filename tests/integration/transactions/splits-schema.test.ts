import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  categories,
  transactionCategorySplits,
  transactions,
} from "../../../database/schema/index.js";
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

guardedDescribe("transaction_category_splits schema (T-186)", () => {
  it("rejects a zero line and a second remainder; cascades and nulls on delete", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const dinner = await seed.insertTransaction(30000n);
      expect(dinner.splitOutOfBalance).toBe(false);

      await expect(
        seed.insertLines(dinner.id, [
          { categoryId: seed.restaurants.id, amount: 0n },
        ]),
      ).rejects.toThrow();
      await expect(
        seed.insertLines(dinner.id, [
          {
            categoryId: seed.restaurants.id,
            amount: 10000n,
            isRemainder: true,
          },
          { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
        ]),
      ).rejects.toThrow();

      await seed.insertLines(dinner.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);
      await db.delete(categories).where(eq(categories.id, seed.restaurants.id));
      const afterCategoryDelete = await db
        .select()
        .from(transactionCategorySplits)
        .where(eq(transactionCategorySplits.transactionId, dinner.id))
        .orderBy(transactionCategorySplits.position);
      expect(afterCategoryDelete.map((line) => line.categoryId)).toEqual([
        null,
        seed.owed.id,
      ]);

      await db.delete(transactions).where(eq(transactions.id, dinner.id));
      const afterTransactionDelete = await db
        .select()
        .from(transactionCategorySplits)
        .where(eq(transactionCategorySplits.transactionId, dinner.id));
      expect(afterTransactionDelete).toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
