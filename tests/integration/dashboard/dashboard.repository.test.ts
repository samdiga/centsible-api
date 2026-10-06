import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  billOccurrences,
  billSetup,
  netWorthSnapshots,
  transactions,
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
      // Rent has nothing scheduled yet, so its next expected date stands in.
      await expect(repository.getUpcomingBills(userId, today)).resolves.toEqual(
        [
          expect.objectContaining({
            canonicalName: "Rent",
            amount: 150000n,
            occurrenceId: null,
            status: "upcoming",
          }),
        ],
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("lists only unsettled occurrences, by their own date and amount", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      const otherUser = randomUUID();
      await db.insert(users).values([
        { id: userId, email: `${userId}@example.test` },
        { id: otherUser, email: `${otherUser}@example.test` },
      ]);
      const [checking] = await db
        .insert(accounts)
        .values({
          userId,
          name: "Checking",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      const today = "2026-10-05";
      const setup = async (
        canonicalName: string,
        fields: Partial<typeof billSetup.$inferInsert> = {},
      ) =>
        (
          await db
            .insert(billSetup)
            .values({
              userId,
              canonicalName,
              cadence: "monthly",
              avgAmount: 10000n,
              // Deliberately stale: occurrences, not this, decide the date.
              nextExpectedDate: "2026-09-01",
              status: "active",
              userConfirmed: true,
              ...fields,
            })
            .returning()
        )[0]!;
      const occur = async (
        bill: { id: string; userId: string },
        dueDate: string,
        fields: Partial<typeof billOccurrences.$inferInsert> = {},
      ) =>
        (
          await db
            .insert(billOccurrences)
            .values({
              userId: bill.userId,
              billSetupId: bill.id,
              occurrenceKey: `${bill.id}:${dueDate}`,
              dueDate,
              expectedAmountCents: 10000n,
              status: "upcoming",
              ...fields,
            })
            .returning()
        )[0]!;
      const [payment] = await db
        .insert(transactions)
        .values({
          userId,
          accountId: checking!.id,
          amount: 10000n,
          date: today,
          name: "PAID",
          status: "posted",
        })
        .returning();

      const power = await setup("Power");
      const powerDue = await occur(power, "2026-10-07");
      await occur(await setup("Paid"), "2026-10-06", {
        status: "paid",
        linkedTransactionId: payment!.id,
      });
      await occur(await setup("Skipped"), "2026-10-06", { status: "skipped" });
      await occur(await setup("Cancelled"), "2026-10-06", {
        status: "cancelled",
      });
      const late = await occur(await setup("Late"), "2026-09-20", {
        status: "overdue",
      });
      // Still "upcoming" though past due: the overdue sweep hasn't run yet.
      const unswept = await occur(await setup("Unswept"), "2026-10-01");
      const moved = await occur(await setup("Moved"), "2026-09-30", {
        dueDateOverride: "2026-10-10",
        expectedAmountOverrideCents: 12345n,
      });
      const byHand = await occur(await setup("By hand"), "2026-10-08", {
        status: "processing",
      });
      await occur(await setup("Old by hand"), "2026-09-28", {
        status: "processing",
      });
      const [charge] = await db
        .insert(transactions)
        .values({
          userId,
          accountId: checking!.id,
          amount: 10000n,
          date: today,
          name: "PENDING",
          status: "pending",
        })
        .returning();
      const held = await occur(await setup("Held"), "2026-10-06", {
        status: "processing",
        pendingTransactionId: charge!.id,
      });
      await occur(await setup("Far off"), "2026-10-25");
      await occur(await setup("Paycheck", { isIncome: true }), "2026-10-06", {
        expectedAmountCents: -500000n,
      });
      await occur(
        await setup("Unconfirmed", { userConfirmed: false }),
        "2026-10-06",
      );
      await occur(await setup("Paused", { status: "paused" }), "2026-10-06");
      await occur(await setup("Theirs", { userId: otherUser }), "2026-10-06");

      const rows = await createDashboardRepository(db).getUpcomingBills(
        userId,
        today,
      );
      expect(
        rows.map((row) => [
          row.canonicalName,
          row.dueDate,
          row.amount,
          row.status,
          row.occurrenceId,
        ]),
      ).toEqual([
        ["Late", "2026-09-20", 10000n, "overdue", late.id],
        ["Unswept", "2026-10-01", 10000n, "upcoming", unswept.id],
        ["Held", "2026-10-06", 10000n, "processing", held.id],
        ["Power", "2026-10-07", 10000n, "upcoming", powerDue.id],
        ["By hand", "2026-10-08", 10000n, "processing", byHand.id],
        ["Moved", "2026-10-10", 12345n, "upcoming", moved.id],
      ]);
      expect(
        rows.filter((row) => row.hasPayment).map((row) => row.canonicalName),
      ).toEqual(["Held"]);
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
      expect(weekly.map((row) => row.date)).toEqual([
        "2026-06-01",
        "2026-06-15",
      ]);
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
        repository.getNetWorthHistory(
          userId,
          "2026-08-01",
          "2026-08-31",
          "daily",
        ),
      ).resolves.toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
