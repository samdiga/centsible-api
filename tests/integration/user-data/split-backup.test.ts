import { describe, expect, it } from "vitest";

import { createUserDataRepository } from "../../../src/modules/user-data/user-data.repository.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import { createTransactionService } from "../../../src/modules/transactions/transactions.service.js";
import { ValidationError } from "../../../src/platform/errors/app-error.js";
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

guardedDescribe("backups carry split lines (T-186)", () => {
  it("exports lines and restores them on import; rejects lines that don't add up", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const userData = createUserDataRepository(db);
      const dinner = await seed.insertTransaction(30000n, {
        categoryId: seed.owed.id,
      });
      await seed.insertLines(dinner.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);
      const plain = await seed.insertTransaction(1500n, {
        categoryId: seed.coffee.id,
      });

      const metadata = await userData.exportMetadata(seed.userId);
      const transactions = await userData.listTransactionPage(
        seed.userId,
        null,
      );
      const exported = new Map(transactions.map((t) => [t.id, t]));
      expect(exported.get(dinner.id)!.splits).toEqual([
        {
          categoryId: seed.restaurants.id,
          amount: "10000",
          position: 0,
          isRemainder: false,
        },
        {
          categoryId: seed.owed.id,
          amount: "20000",
          position: 1,
          isRemainder: true,
        },
      ]);
      expect(exported.get(dinner.id)!.splitOutOfBalance).toBe(false);
      expect(exported.get(plain.id)!.splits).toBeUndefined();

      const payload = { ...metadata, transactions };
      const broken = {
        ...payload,
        transactions: transactions.map((t) =>
          t.id === dinner.id
            ? {
                ...t,
                splits: t.splits!.map((l) => ({ ...l, amount: "10000" })),
              }
            : t,
        ),
      };
      await expect(
        userData.validateBackupReferences(seed.userId, broken),
      ).rejects.toBeInstanceOf(ValidationError);

      await userData.validateBackupReferences(seed.userId, payload);
      await db.transaction(async (tx) => {
        await userData.resetUserData(seed.userId, tx);
        await userData.importUserData(seed.userId, payload, tx);
      });
      const restored = await createTransactionRepository(db).listSplitLines(
        seed.userId,
        [dinner.id],
      );
      expect(
        restored.get(dinner.id)!.map((l) => [l.categoryId, l.amount]),
      ).toEqual([
        [seed.restaurants.id, 10000n],
        [seed.owed.id, 20000n],
      ]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("formats a split's CSV category cell from integer cents", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const dinner = await seed.insertTransaction(30005n, {
        categoryId: seed.owed.id,
      });
      await seed.insertLines(dinner.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: null, amount: 5n },
        { categoryId: seed.owed.id, amount: 20000n, isRemainder: true },
      ]);
      const { csv } = await createTransactionService({
        repository: createTransactionRepository(db),
      }).exportTransactionsCsv(seed.userId, {});
      expect(csv.split("\n")[1]).toContain(
        ",Restaurants $100.00; Uncategorized $0.05; Owed to me $200.00,",
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
