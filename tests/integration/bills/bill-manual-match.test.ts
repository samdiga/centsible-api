import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  billOccurrences,
  billSetup,
  forecastEvents,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
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

guardedDescribe("matching bill payments by hand", () => {
  it("stores rejected pairs, reopens forecasts, and lists only free outflows", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const bills = createBillsRepository(db);
      const occurrencesRepo = createBillOccurrencesRepository(db);
      const me = randomUUID();
      const other = randomUUID();
      await db.insert(users).values([
        { id: me, email: `${me}@example.test`, name: "U" },
        { id: other, email: `${other}@example.test`, name: "O" },
      ]);
      const [checking, closed, theirs] = await db
        .insert(accounts)
        .values([
          {
            userId: me,
            name: "360 Checking",
            type: "depository",
            subtype: "checking",
            currency: "USD",
            isManual: true,
          },
          {
            userId: me,
            name: "Closed",
            type: "depository",
            subtype: "checking",
            currency: "USD",
            isManual: true,
            deletedAt: new Date(),
          },
          {
            userId: other,
            name: "Theirs",
            type: "depository",
            subtype: "checking",
            currency: "USD",
            isManual: true,
          },
        ])
        .returning();
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId: me,
          canonicalName: "robinhood",
          cadence: "weekly",
          avgAmount: 20000n,
          nextExpectedDate: "2026-10-06",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const [thisWeek, nextWeek] = await db
        .insert(billOccurrences)
        .values([
          {
            userId: me,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:2026-10-06`,
            dueDate: "2026-10-06",
            expectedAmountCents: 20000n,
            status: "paid",
          },
          {
            userId: me,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:2026-10-13`,
            dueDate: "2026-10-13",
            expectedAmountCents: 20000n,
            status: "upcoming",
          },
        ])
        .returning();
      const txn = (
        userId: string,
        accountId: string,
        fields: Partial<typeof transactions.$inferInsert> = {},
      ) => ({
        userId,
        accountId,
        amount: 20000n,
        date: "2026-10-01",
        currency: "USD",
        name: "FIDELITY INVESTMENTS",
        status: "posted" as const,
        ...fields,
      });
      const [
        fidelity,
        robinhood,
        heldElsewhere,
        inflow,
        pending,
        deleted,
        onClosed,
        outside,
        notMine,
      ] = await db
        .insert(transactions)
        .values([
          txn(me, checking!.id),
          txn(me, checking!.id, {
            name: "ROBINHOOD DES:FUNDS",
            date: "2026-10-05",
          }),
          txn(me, checking!.id, { date: "2026-10-12" }),
          txn(me, checking!.id, { amount: -20000n }),
          txn(me, checking!.id, { status: "pending" }),
          txn(me, checking!.id, { deletedAt: new Date() }),
          txn(me, closed!.id),
          txn(me, checking!.id, { date: "2026-12-01" }),
          txn(other, theirs!.id),
        ])
        .returning();
      await db
        .update(billOccurrences)
        .set({ linkedTransactionId: fidelity!.id })
        .where(eq(billOccurrences.id, thisWeek!.id));
      await db
        .update(billOccurrences)
        .set({ pendingTransactionId: heldElsewhere!.id })
        .where(eq(billOccurrences.id, nextWeek!.id));

      // Candidates for this week: its own match stays listed; a payment
      // another occurrence holds, inflows, pending, deleted, closed-account,
      // out-of-range and other users' rows do not.
      const candidates = await bills.listLinkCandidates(
        me,
        "2026-09-05",
        "2026-11-06",
        thisWeek!.id,
      );
      expect(candidates.map((row) => row.id).sort()).toEqual(
        [fidelity!.id, robinhood!.id].sort(),
      );
      expect(candidates.find((row) => row.id === robinhood!.id)).toMatchObject({
        accountId: checking!.id,
        accountName: "360 Checking",
        amount: 20000n,
        isCard: false,
      });
      for (const excluded of [
        heldElsewhere,
        inflow,
        pending,
        deleted,
        onClosed,
        outside,
        notMine,
      ])
        expect(candidates.map((row) => row.id)).not.toContain(excluded!.id);

      // Rejections: idempotent, per user, and clearable.
      await bills.rejectMatch(me, thisWeek!.id, fidelity!.id);
      await bills.rejectMatch(me, thisWeek!.id, fidelity!.id);
      expect(
        await bills.listRejectedPairs(me, [thisWeek!.id, nextWeek!.id]),
      ).toEqual(new Set([`${thisWeek!.id}:${fidelity!.id}`]));
      expect((await bills.listRejectedPairs(other, [thisWeek!.id])).size).toBe(
        0,
      );
      expect((await bills.listRejectedPairs(me, [])).size).toBe(0);
      await bills.clearRejection(me, thisWeek!.id, fidelity!.id);
      expect((await bills.listRejectedPairs(me, [thisWeek!.id])).size).toBe(0);

      // Reopening undoes only the matching resolution.
      const [event] = await db
        .insert(forecastEvents)
        .values({
          userId: me,
          name: "robinhood",
          amount: 20000n,
          date: "2026-10-06",
          recurringSeriesId: bill!.id,
          billOccurrenceId: thisWeek!.id,
          sourceType: "recurring",
          resolvedToTransactionId: fidelity!.id,
        })
        .returning();
      await bills.reopenBillForecastEvent(me, thisWeek!.id, robinhood!.id);
      const resolved = async () =>
        (
          await db
            .select()
            .from(forecastEvents)
            .where(eq(forecastEvents.id, event!.id))
        )[0]!.resolvedToTransactionId;
      expect(await resolved()).toBe(fidelity!.id);
      await bills.reopenBillForecastEvent(me, thisWeek!.id, fidelity!.id);
      expect(await resolved()).toBeNull();

      // Summaries carry the paying account's name.
      const summaries = await occurrencesRepo.linkedTransactionSummaries(me, [
        robinhood!.id,
        onClosed!.id,
      ]);
      expect(summaries.get(robinhood!.id)).toMatchObject({
        name: "ROBINHOOD DES:FUNDS",
        accountName: "360 Checking",
        amountCents: "20000",
      });
      expect(summaries.get(onClosed!.id)?.accountName).toBeNull();

      // Deleting an occurrence removes its rejections.
      await bills.rejectMatch(me, nextWeek!.id, robinhood!.id);
      await db
        .delete(billOccurrences)
        .where(eq(billOccurrences.id, nextWeek!.id));
      expect((await bills.listRejectedPairs(me, [nextWeek!.id])).size).toBe(0);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
