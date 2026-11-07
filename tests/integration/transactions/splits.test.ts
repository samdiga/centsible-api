import { describe, expect, it } from "vitest";

import { createWithUserMutation } from "../../../src/platform/cache/user-revisions.repository.js";
import { AppError } from "../../../src/platform/errors/app-error.js";
import { manualTransactionRepository } from "../../../src/modules/transactions/manual-transactions.repository.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import { createTransactionService } from "../../../src/modules/transactions/transactions.service.js";
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

type TestDb = Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"];

const serviceFor = (db: TestDb) =>
  createTransactionService({
    repository: createTransactionRepository(db),
    manualRepository: manualTransactionRepository,
    rules: { listActiveRules: async () => [] },
    cache: {
      getOrCompute: (_key, compute) => compute(),
      invalidateUser: () => undefined,
    },
    withUserMutation: createWithUserMutation({
      db,
      cache: { invalidateUser: () => undefined },
    }),
  });

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

guardedDescribe("transaction splits: save, unsplit, read (T-186)", () => {
  it("saves lines, derives the category, and guards amount and status", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const service = serviceFor(db);
      const dinner = await seed.insertTransaction(30000n);
      const lines = [
        { categoryId: seed.restaurants.id, amount: 10000n, isRemainder: false },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ];

      const saved = await service.putSplits(seed.userId, dinner.id, {
        expectedAmount: 30000n,
        lines,
      });
      expect(saved.categoryId).toBe(seed.owed.id);
      expect(saved.userCategoryOverride).toBe(true);
      expect(saved.splitOutOfBalance).toBe(false);
      const detail = await service.getTransaction(seed.userId, dinner.id);
      expect(detail.splits).toEqual([
        { categoryId: seed.restaurants.id, amount: "10000", position: 0, isRemainder: false },
        { categoryId: seed.owed.id, amount: "20000", position: 1, isRemainder: true },
      ]);
      const page = await service.listTransactions(seed.userId, {});
      const row = page.transactions.find((t) => t.id === dinner.id)!;
      expect(row.splitCategoryIds).toEqual([seed.restaurants.id, seed.owed.id]);
      expect(row.splits).toBeUndefined();

      const changed = await appError(
        service.putSplits(seed.userId, dinner.id, { expectedAmount: 29900n, lines }),
      );
      expect(changed.httpStatus).toBe(409);
      expect(changed.code).toBe("AMOUNT_CHANGED");
      expect(changed.details).toEqual({ currentAmount: "30000" });

      const badSum = await appError(
        service.putSplits(seed.userId, dinner.id, {
          expectedAmount: 30000n,
          lines: [lines[0]!, { ...lines[1]!, amount: 10000n }],
        }),
      );
      expect([badSum.httpStatus, badSum.code]).toEqual([422, "sum_mismatch"]);

      const pending = await seed.insertTransaction(5000n, { status: "pending" });
      const pendingError = await appError(
        service.putSplits(seed.userId, pending.id, {
          expectedAmount: 5000n,
          lines: [
            { categoryId: seed.restaurants.id, amount: 2000n, isRemainder: false },
            { categoryId: seed.owed.id, amount: 3000n, isRemainder: true },
          ],
        }),
      );
      expect([pendingError.httpStatus, pendingError.code]).toEqual([
        422,
        "TRANSACTION_PENDING",
      ]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("unsplits on an empty or one-line save and on a different single category", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const service = serviceFor(db);
      const dinner = await seed.insertTransaction(30000n);
      const split = () =>
        service.putSplits(seed.userId, dinner.id, {
          expectedAmount: 30000n,
          lines: [
            { categoryId: seed.restaurants.id, amount: 10000n, isRemainder: false },
            { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
          ],
        });

      await split();
      const empty = await service.putSplits(seed.userId, dinner.id, {
        expectedAmount: 30000n,
        lines: [],
      });
      expect(empty.splits).toEqual([]);
      expect(empty.categoryId).toBe(seed.owed.id);

      await split();
      const one = await service.putSplits(seed.userId, dinner.id, {
        expectedAmount: 30000n,
        lines: [{ categoryId: seed.coffee.id, amount: 30000n, isRemainder: true }],
      });
      expect(one.splits).toEqual([]);
      expect(one.categoryId).toBe(seed.coffee.id);

      // An older app re-sending the derived category with a note keeps the split.
      await split();
      const noted = await service.patchTransaction(seed.userId, dinner.id, {
        notes: "team dinner",
        categoryId: seed.owed.id,
      });
      expect(noted.splits).toHaveLength(2);

      const recategorised = await service.patchTransaction(seed.userId, dinner.id, {
        categoryId: seed.restaurants.id,
      });
      expect(recategorised.splits).toEqual([]);
      expect(recategorised.categoryId).toBe(seed.restaurants.id);

      await split();
      await service.bulkPatchTransactions(seed.userId, {
        ids: [dinner.id],
        patch: { categoryId: seed.coffee.id },
      });
      const bulk = await service.getTransaction(seed.userId, dinner.id);
      expect(bulk.splits).toEqual([]);
      expect(bulk.categoryId).toBe(seed.coffee.id);

      await split();
      await service.bulkPatchTransactions(seed.userId, {
        ids: [dinner.id],
        patch: { reviewStatus: "reviewed" },
      });
      expect((await service.getTransaction(seed.userId, dinner.id)).splits).toHaveLength(2);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("rebalances a manual transaction's split when its amount is edited", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const service = serviceFor(db);
      const cash = await seed.insertTransaction(30000n, {
        accountId: seed.manualChecking.id,
        plaidTransactionId: null,
      });
      await service.putSplits(seed.userId, cash.id, {
        expectedAmount: 30000n,
        lines: [
          { categoryId: seed.restaurants.id, amount: 10000n, isRemainder: false },
          { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
        ],
      });

      const tipped = await service.patchTransaction(seed.userId, cash.id, { amount: 32000n });
      expect(tipped.splits?.map((line) => line.amount)).toEqual(["10000", "22000"]);
      expect(tipped.splitOutOfBalance).toBe(false);

      const flipped = await service.patchTransaction(seed.userId, cash.id, { amount: -5000n });
      expect(flipped.splitOutOfBalance).toBe(true);
      expect(flipped.splits?.map((line) => line.amount)).toEqual(["10000", "22000"]);
      expect(flipped.categoryId).toBe(seed.owed.id);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
