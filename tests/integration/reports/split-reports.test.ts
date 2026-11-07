import { describe, expect, it } from "vitest";

import { createReportsRepository } from "../../../src/modules/reports/reports.repository.js";
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

guardedDescribe("reports count split lines (T-186)", () => {
  it("puts each line in its own category in spending and trends", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const seed = await seedSplitUser(db);
      const reports = createReportsRepository(db);
      const dinner = await seed.insertTransaction(30000n, { categoryId: seed.owed.id });
      await seed.insertLines(dinner.id, [
        { categoryId: seed.restaurants.id, amount: 10000n },
        { categoryId: null, amount: 5000n },
        { categoryId: seed.owed.id, amount: 15000n, isRemainder: true },
      ]);

      const spending = new Map(
        (await reports.getSpendingByCategory(seed.userId, "2026-11-01", "2026-11-30")).map(
          (row) => [row.categoryId, row.totalCents],
        ),
      );
      expect(spending).toEqual(
        new Map([
          [seed.owed.id, 15000n],
          [seed.restaurants.id, 10000n],
          ["uncategorized", 5000n],
        ]),
      );

      const trend = new Map(
        (await reports.getCategoryTrend(seed.userId, "2026-11-01", "2026-11-30")).map(
          (row) => [row.categoryId, row.months.map((m) => m.totalCents)],
        ),
      );
      expect(trend.get(seed.restaurants.id)).toEqual([10000n]);
      expect(trend.get(seed.owed.id)).toEqual([15000n]);
      expect(trend.get("uncategorized")).toEqual([5000n]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
