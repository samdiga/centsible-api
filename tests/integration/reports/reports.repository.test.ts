import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  netWorthSnapshots,
  tags,
  transactions,
  transactionTags,
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

  it("filters by tag with ANY/OR semantics and ignores an unknown tag id", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const accountId = randomUUID();
      const tagA = randomUUID();
      const tagB = randomUUID();
      const unknownTag = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      await testDb.db.insert(accounts).values({
        id: accountId,
        userId,
        name: "Checking",
        type: "depository",
        subtype: "checking",
      });
      await testDb.db.insert(tags).values([
        { id: tagA, userId, name: "Vacation" },
        { id: tagB, userId, name: "Dining" },
      ]);
      const [taggedA, taggedB, untagged] = await testDb.db
        .insert(transactions)
        .values([
          {
            userId,
            accountId,
            amount: 1000n,
            date: "2026-05-01",
            status: "posted",
            name: "Hotel",
          },
          {
            userId,
            accountId,
            amount: 2000n,
            date: "2026-05-02",
            status: "posted",
            name: "Dinner",
          },
          {
            userId,
            accountId,
            amount: 3000n,
            date: "2026-05-03",
            status: "posted",
            name: "Groceries",
          },
        ])
        .returning({ id: transactions.id });
      await testDb.db.insert(transactionTags).values([
        { transactionId: taggedA!.id, tagId: tagA },
        { transactionId: taggedB!.id, tagId: tagB },
      ]);
      void untagged;

      const repository = createReportsRepository(testDb.db);

      const anyMatch = await repository.getSpendingByCategory(
        userId,
        "2026-05-01",
        "2026-05-31",
        [tagA, tagB],
      );
      expect(
        anyMatch.reduce((sum, row) => sum + row.totalCents, 0n),
      ).toBe(3000n); // hotel (1000) + dinner (2000), groceries excluded

      const unknownTagMatch = await repository.getSpendingByCategory(
        userId,
        "2026-05-01",
        "2026-05-31",
        [unknownTag],
      );
      expect(unknownTagMatch).toEqual([]);

      const noFilter = await repository.getSpendingByCategory(
        userId,
        "2026-05-01",
        "2026-05-31",
      );
      expect(
        noFilter.reduce((sum, row) => sum + row.totalCents, 0n),
      ).toBe(6000n);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("getCategoryTrend buckets everything outside the top N into Other, and every month's parts sum to its true total", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const accountId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      await testDb.db.insert(accounts).values({
        id: accountId,
        userId,
        name: "Checking",
        type: "depository",
        subtype: "checking",
      });
      // 7 categories so one must fall into "Other" against CATEGORY_TREND_TOP_N=6.
      const categoryIds = await Promise.all(
        Array.from({ length: 7 }, async (_, i) => {
          const id = randomUUID();
          await testDb.db.insert(categories).values({
            id,
            userId,
            name: `Category ${i}`,
          });
          return id;
        }),
      );
      // Descending amounts so category 6 (smallest) is reliably the one
      // bumped into Other.
      await testDb.db.insert(transactions).values(
        categoryIds.map((categoryId, i) => ({
          userId,
          accountId,
          categoryId,
          amount: BigInt((7 - i) * 1000),
          date: "2026-05-15",
          status: "posted" as const,
          name: `Purchase ${i}`,
        })),
      );

      const repository = createReportsRepository(testDb.db);
      const result = await repository.getCategoryTrend(
        userId,
        "2026-05-01",
        "2026-05-31",
      );

      expect(result).toHaveLength(7); // 6 real categories + Other
      const other = result.find((row) => row.categoryId === "other");
      expect(other?.months).toEqual([{ month: "2026-05", totalCents: 1000n }]);

      // True total for the month: (7+6+5+4+3+2+1) * 1000 = 28000. Asserting
      // the top-6-plus-Other split sums back to this proves no spend was
      // dropped or double-counted across the two aggregate queries.
      const summedAcrossAllCategories = result.reduce(
        (sum, row) =>
          sum + row.months.reduce((s, m) => s + m.totalCents, 0n),
        0n,
      );
      expect(summedAcrossAllCategories).toBe(28000n);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
