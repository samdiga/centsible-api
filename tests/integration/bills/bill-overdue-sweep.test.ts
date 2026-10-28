import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  billSetup,
  billOccurrences,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { dateInTimeZone } from "../../../src/modules/bills/local-date.js";
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
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
guardedDescribe("overdue sweep", () => {
  it("marks only bills due before the user's own today overdue, and puts early ones back", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb,
        userId = randomUUID(),
        timezone = "America/New_York";
      await db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "U",
        timezone,
      });
      const occurrences = createBillOccurrencesRepository(db);
      const today = dateInTimeZone(new Date(), timezone);
      await expect(occurrences.localToday(userId)).resolves.toBe(today);
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "robinhood",
          cadence: "weekly",
          avgAmount: 20000n,
          nextExpectedDate: today,
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const rows = await db
        .insert(billOccurrences)
        .values(
          (
            [
              ["yesterday", shift(today, -1), "upcoming"],
              ["today", today, "upcoming"],
              ["today-marked-early", today, "overdue"],
              ["tomorrow-marked-early", shift(today, 1), "overdue"],
              ["paid-yesterday", shift(today, -1), "paid"],
            ] as const
          ).map(([key, dueDate, status], index) => ({
            userId,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:${key}`,
            // Keep the due-date unique index happy: same day, distinct rows.
            dueDate: index >= 2 ? shift(today, 400 + index) : dueDate,
            dueDateOverride: index >= 2 ? dueDate : null,
            expectedAmountCents: 20000n,
            status,
          })),
        )
        .returning();
      await expect(occurrences.sweepOverdue(userId)).resolves.toBe(3);
      const after = new Map(
        (await occurrences.listBySetup(userId, bill!.id)).map((row) => [
          row.occurrenceKey.split(":")[1],
          row.status,
        ]),
      );
      expect(Object.fromEntries(after)).toEqual({
        yesterday: "overdue",
        today: "upcoming",
        "today-marked-early": "upcoming",
        "tomorrow-marked-early": "upcoming",
        "paid-yesterday": "paid",
      });
      expect(rows).toHaveLength(5);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
