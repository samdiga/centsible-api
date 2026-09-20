import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  billSetup,
  netWorthSnapshots,
  users,
} from "../../../database/schema/index.js";
import { createDashboardRepository } from "../../../src/modules/dashboard/dashboard.repository.js";
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

guardedDescribe("dashboard repository", () => {
  it("returns only live user accounts and confirmed upcoming payable bills", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      await testDb.db.insert(accounts).values({
        id: randomUUID(),
        userId,
        name: "Checking",
        type: "depository",
        subtype: "checking",
        currentBalance: 300000n,
        availableBalance: 290000n,
      });
      const today = new Date().toISOString().slice(0, 10);
      await testDb.db.insert(billSetup).values({
        userId,
        canonicalName: "Rent",
        cadence: "monthly",
        avgAmount: 150000n,
        nextExpectedDate: today,
        status: "active",
        userConfirmed: true,
      });
      await testDb.db.insert(billSetup).values({
        userId,
        canonicalName: "Unconfirmed",
        cadence: "monthly",
        avgAmount: 100n,
        nextExpectedDate: today,
        status: "active",
        userConfirmed: false,
      });

      const repository = createDashboardRepository(testDb.db);
      await expect(repository.listAccounts(userId)).resolves.toEqual([
        expect.objectContaining({
          type: "depository",
          currentBalance: 300000n,
          availableBalance: 290000n,
        }),
      ]);
      await expect(repository.getUpcomingBills(userId)).resolves.toEqual([
        expect.objectContaining({ canonicalName: "Rent", avgAmount: 150000n }),
      ]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("getNetWorthHistory returns daily rows verbatim, ascending, and tolerates a gap", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      // 2026-08-02 deliberately missing — a real gap, not filled/interpolated.
      await testDb.db.insert(netWorthSnapshots).values([
        {
          userId,
          date: "2026-08-01",
          totalAssets: 100000n,
          totalLiabilities: 20000n,
          netWorth: 80000n,
          liquidAssets: 50000n,
          breakdown: {},
        },
        {
          userId,
          date: "2026-08-03",
          totalAssets: 110000n,
          totalLiabilities: 20000n,
          netWorth: 90000n,
          liquidAssets: 55000n,
          breakdown: {},
        },
      ]);

      const repository = createDashboardRepository(testDb.db);
      const rows = await repository.getNetWorthHistory(
        userId,
        "2026-08-01",
        "2026-08-31",
        "daily",
      );

      expect(rows).toEqual([
        {
          date: "2026-08-01",
          netWorthCents: 80000n,
          assetsCents: 100000n,
          liabilitiesCents: 20000n,
        },
        {
          date: "2026-08-03",
          netWorthCents: 90000n,
          assetsCents: 110000n,
          liabilitiesCents: 20000n,
        },
      ]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("getNetWorthHistory buckets weekly and monthly to the last real snapshot in each bucket, still ascending", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      await testDb.db.insert(netWorthSnapshots).values([
        {
          userId,
          date: "2026-06-01",
          totalAssets: 100000n,
          totalLiabilities: 10000n,
          netWorth: 90000n,
          liquidAssets: 40000n,
          breakdown: {},
        },
        {
          userId,
          date: "2026-06-15",
          totalAssets: 120000n,
          totalLiabilities: 10000n,
          netWorth: 110000n,
          liquidAssets: 45000n,
          breakdown: {},
        },
        {
          userId,
          date: "2026-07-10",
          totalAssets: 130000n,
          totalLiabilities: 10000n,
          netWorth: 120000n,
          liquidAssets: 50000n,
          breakdown: {},
        },
      ]);

      const repository = createDashboardRepository(testDb.db);

      const monthly = await repository.getNetWorthHistory(
        userId,
        "2026-06-01",
        "2026-07-31",
        "monthly",
      );
      // June's last snapshot is 06-15 (110000), not 06-01 (90000) — proves
      // "last in bucket", not "first" or an average.
      expect(monthly).toEqual([
        {
          date: "2026-06-15",
          netWorthCents: 110000n,
          assetsCents: 120000n,
          liabilitiesCents: 10000n,
        },
        {
          date: "2026-07-10",
          netWorthCents: 120000n,
          assetsCents: 130000n,
          liabilitiesCents: 10000n,
        },
      ]);

      const weekly = await repository.getNetWorthHistory(
        userId,
        "2026-06-01",
        "2026-06-30",
        "weekly",
      );
      expect(weekly.map((row) => row.date)).toEqual(["2026-06-01", "2026-06-15"]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("getNetWorthHistory returns an empty array with no snapshots in range", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });

      const repository = createDashboardRepository(testDb.db);
      await expect(
        repository.getNetWorthHistory(userId, "2026-08-01", "2026-08-31", "daily"),
      ).resolves.toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
