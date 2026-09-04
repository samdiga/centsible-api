import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  netWorthSnapshots,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createReportsRepository } from "../../../src/modules/reports/reports.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

guardedDescribe("reports repository", () => {
  it("aggregates posted included transactions and keeps each user isolated", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherUserId = randomUUID();
      const accountId = randomUUID();
      const categoryId = randomUUID();
      await testDb.db.insert(users).values([
        { id: userId, email: `${userId}@example.test` },
        { id: otherUserId, email: `${otherUserId}@example.test` },
      ]);
      await testDb.db.insert(accounts).values({
        id: accountId,
        userId,
        name: "Checking",
        type: "depository",
        subtype: "checking",
      });
      await testDb.db.insert(categories).values({
        id: categoryId,
        userId,
        name: "Dining",
      });
      await testDb.db.insert(transactions).values([
        {
          userId,
          accountId,
          amount: 1250n,
          date: "2026-05-01",
          status: "posted",
          name: "Lunch",
          categoryId,
        },
        {
          userId,
          accountId,
          amount: -5000n,
          date: "2026-05-02",
          status: "posted",
          name: "Paycheck",
        },
        {
          userId,
          accountId,
          amount: 999n,
          date: "2026-05-03",
          status: "pending",
          name: "Pending",
        },
      ]);
      await testDb.db.insert(netWorthSnapshots).values({
        userId,
        date: "2026-05-31",
        totalAssets: 800000n,
        totalLiabilities: 300000n,
        netWorth: 500000n,
        liquidAssets: 200000n,
        breakdown: {},
      });

      const repository = createReportsRepository(testDb.db);
      await expect(
        repository.getSpendingByCategory(userId, "2026-05-01", "2026-05-31"),
      ).resolves.toEqual([{ categoryId, name: "Dining", totalCents: 1250n }]);
      await expect(
        repository.getMonthlyIncome(userId, "2026-05-01", "2026-05-31"),
      ).resolves.toEqual([{ month: "2026-05", totalCents: 5000n }]);
      await expect(
        repository.getNetWorthSnapshots(userId, "2026-05-01", "2026-05-31"),
      ).resolves.toEqual([{ month: "2026-05", netWorthCents: 500000n }]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
