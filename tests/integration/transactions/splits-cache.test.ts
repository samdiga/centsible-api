import { describe, expect, it } from "vitest";

import { createCategoryRepository } from "../../../src/modules/categories/categories.repository.js";
import { createCategoryService } from "../../../src/modules/categories/categories.service.js";
import { manualTransactionRepository } from "../../../src/modules/transactions/manual-transactions.repository.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import { createTransactionService } from "../../../src/modules/transactions/transactions.service.js";
import { createResponseCache } from "../../../src/platform/cache/response-cache.js";
import {
  createWithUserMutation,
  getUserRevision,
} from "../../../src/platform/cache/user-revisions.repository.js";
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

guardedDescribe("split writes invalidate cached reads (T-186)", () => {
  it("a split save and a category archive both bump the revision a cached list keys on", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const cache = createResponseCache();
      const withUserMutation = createWithUserMutation({ db, cache });
      const service = createTransactionService({
        repository: createTransactionRepository(db),
        manualRepository: manualTransactionRepository,
        rules: { listActiveRules: async () => [] },
        cache,
        getUserRevision: (userId) => getUserRevision(userId, db),
        withUserMutation,
      });
      const categories = createCategoryService({
        repository: createCategoryRepository(db),
        withUserMutation,
        getUserRevision: (userId) => getUserRevision(userId, db),
      });
      const dinner = await seed.insertTransaction(30000n, { categoryId: seed.owed.id });
      const row = async () =>
        (await service.listTransactions(seed.userId, {})).transactions.find(
          (t) => t.id === dinner.id,
        )!;

      expect((await row()).splitCategoryIds).toBeUndefined();
      const before = await getUserRevision(seed.userId, db);
      await service.putSplits(seed.userId, dinner.id, {
        expectedAmount: 30000n,
        lines: [
          { categoryId: seed.coffee.id, amount: 10000n, isRemainder: false },
          { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
        ],
      });
      expect(await getUserRevision(seed.userId, db)).toBeGreaterThan(before);
      expect((await row()).splitCategoryIds).toEqual([seed.coffee.id, seed.owed.id]);

      await categories.archiveCategory(seed.userId, seed.coffee.id, {
        reassignTo: seed.restaurants.id,
      });
      expect((await row()).splitCategoryIds).toEqual([seed.restaurants.id, seed.owed.id]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
