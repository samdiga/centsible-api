import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  billSetup,
  billOccurrences,
  forecastEvents,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import { materializeBillsForUser } from "../../../src/modules/bills/bills.service.js";
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
guardedDescribe("detected weekly bill whose payment day moves", () => {
  it("replaces the old day's future occurrences instead of adding a second series", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb,
        userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const repository = createBillsRepository(db),
        occurrences = createBillOccurrencesRepository(db);
      let today = "2026-10-01";
      const deps = {
        repository,
        occurrences,
        now: () => new Date(`${today}T12:00:00Z`),
        withUserMutation: async <T>(
          _id: string,
          cb: Parameters<typeof db.transaction<T>>[0],
        ) => db.transaction(cb),
      };
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "fidelity $50 1/2",
          cadence: "weekly",
          avgAmount: 5000n,
          nextExpectedDate: "2026-10-06",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const materialize = () =>
        materializeBillsForUser(userId, bill!.id, 2, deps);
      const pay = (dueDate: string) =>
        db
          .update(billOccurrences)
          .set({ status: "paid", markedPaidAt: new Date() })
          .where(
            and(
              eq(billOccurrences.billSetupId, bill!.id),
              eq(billOccurrences.dueDate, dueDate),
            ),
          );
      // Detection re-anchors on the latest payment, as recurring-engine does.
      const detectPayment = (postedOn: string, next: string) =>
        db
          .update(billSetup)
          .set({ lastOccurredOn: postedOn, nextExpectedDate: next })
          .where(eq(billSetup.id, bill!.id));
      const upcomingFrom = async (from: string) =>
        (await occurrences.listBySetup(userId, bill!.id))
          .filter((row) => row.status === "upcoming" && row.dueDate >= from)
          .map((row) => row.dueDate)
          .sort();

      await materialize();
      await materialize();
      expect(
        (await occurrences.listBySetup(userId, bill!.id)).filter(
          (row) => row.status === "cancelled",
        ),
      ).toEqual([]);
      await pay("2026-10-06");
      await pay("2026-10-13");

      // Tue Oct 13 was a bank holiday: the payment posts Wed Oct 14 and is
      // matched to the Oct 20 occurrence, moving the schedule to Wednesdays.
      today = "2026-10-14";
      await pay("2026-10-20");
      await detectPayment("2026-10-14", "2026-10-21");
      await materialize();
      const wednesdays = await upcomingFrom(today);
      expect(wednesdays.slice(0, 3)).toEqual([
        "2026-10-21",
        "2026-10-28",
        "2026-11-04",
      ]);
      expect(
        wednesdays.every((date) => new Date(date).getUTCDay() === 3),
      ).toBe(true);

      // Back on Tuesdays from Oct 20: the Wednesday series must go again.
      today = "2026-10-21";
      await pay("2026-10-21");
      await detectPayment("2026-10-20", "2026-10-27");
      await materialize();
      const tuesdays = await upcomingFrom(today);
      expect(tuesdays.slice(0, 3)).toEqual([
        "2026-10-27",
        "2026-11-03",
        "2026-11-10",
      ]);
      expect(tuesdays.every((date) => new Date(date).getUTCDay() === 2)).toBe(
        true,
      );

      const rows = await occurrences.listBySetup(userId, bill!.id);
      expect(
        rows
          .filter((row) => row.status === "paid")
          .map((row) => row.dueDate)
          .sort(),
      ).toEqual(["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-21"]);
      const live = await db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, userId));
      const liveDates = live
        .filter((row) => row.deletedAt === null && row.date >= today)
        .map((row) => row.date);
      expect(liveDates).toContain("2026-10-27");
      expect(liveDates).not.toContain("2026-10-28");
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
