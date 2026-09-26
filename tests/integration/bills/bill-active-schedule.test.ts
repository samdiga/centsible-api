import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  billSetup,
  billOccurrences,
  forecastEvents,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import {
  createBillsService,
  materializeBillsForUser,
} from "../../../src/modules/bills/bills.service.js";
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
guardedDescribe("confirmed bill schedule changes", () => {
  it("atomically replaces future dates, preserves protected history and overrides, and reuses retired IDs on a later schedule", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb,
        userId = randomUUID(),
        otherUserId = randomUUID();
      await db.insert(users).values(
        [userId, otherUserId].map((id) => ({
          id,
          email: `${id}@example.test`,
          name: "U",
        })),
      );
      const repository = createBillsRepository(db),
        occurrences = createBillOccurrencesRepository(db);
      const deps = {
        repository,
        occurrences,
        now: () => new Date("2026-10-01T12:00:00Z"),
        withUserMutation: async <T>(
          _id: string,
          cb: Parameters<typeof db.transaction<T>>[0],
        ) => db.transaction(cb),
        billDispatcher: { detect: async () => {}, materialize: async () => {} },
      };
      const service = createBillsService(deps);
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Original detection",
          cadence: "monthly",
          avgAmount: 8000n,
          nextExpectedDate: "2026-10-15",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      await materializeBillsForUser(userId, bill!.id, 3, deps);
      let rows = await occurrences.listBySetup(userId, bill!.id);
      const october = rows.find((row) => row.dueDate === "2026-10-15")!,
        november = rows.find((row) => row.dueDate === "2026-11-15")!,
        december = rows.find((row) => row.dueDate === "2026-12-15")!;
      await db
        .update(billOccurrences)
        .set({
          status: "processing",
          paidAmountCents: 8000n,
          markedPaidAt: new Date(),
        })
        .where(eq(billOccurrences.id, november.id));
      await service.updateOccurrence(userId, bill!.id, december.id, {
        amountCents: 9000n,
        dueDate: "2026-12-20",
      });
      const [history] = await db
        .insert(billOccurrences)
        .values({
          userId,
          billSetupId: bill!.id,
          occurrenceKey: `${bill!.id}:2026-09`,
          dueDate: "2026-09-15",
          expectedAmountCents: 7000n,
          status: "paid",
        })
        .returning();
      await service.updateBill(userId, bill!.id, { endDate: "2026-12-31" });
      const protectedBefore = await occurrences.listBySetup(userId, bill!.id);
      const protectedIds = [history!.id, november.id, december.id];
      await expect(
        service.updateBill(otherUserId, bill!.id, { amountCents: 11000n }),
      ).rejects.toThrow();
      await expect(
        service.updateBill(userId, bill!.id, {
          nextExpectedDate: "2026-09-30",
        }),
      ).rejects.toThrow("today or later");
      await service.updateBill(userId, bill!.id, {
        amountCents: 11000n,
        nextExpectedDate: "2026-10-20",
      });
      rows = await occurrences.listBySetup(userId, bill!.id);
      expect(rows.find((row) => row.id === october.id)).toMatchObject({
        status: "cancelled",
        occurrenceKey: `${bill!.id}:rescheduled:${october.id}`,
      });
      expect(
        rows
          .filter(
            (row) =>
              row.status === "upcoming" &&
              row.dueDateOverride === null &&
              row.expectedAmountOverrideCents === null,
          )
          .map((row) => row.dueDate),
      ).toEqual(["2026-10-20"]);
      for (const id of protectedIds)
        expect(rows.find((row) => row.id === id)).toEqual(
          protectedBefore.find((row) => row.id === id),
        );
      let events = await db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, userId));
      expect(
        events.find((row) => row.billOccurrenceId === october.id)?.deletedAt,
      ).not.toBeNull();
      expect(events.find((row) => row.date === "2026-10-20")).toMatchObject({
        amount: 11000n,
        deletedAt: null,
      });
      await service.updateBill(userId, bill!.id, {
        cadence: "weekly",
        nextExpectedDate: "2026-10-22",
      });
      rows = await occurrences.listBySetup(userId, bill!.id);
      expect(
        rows
          .filter(
            (row) =>
              row.status === "upcoming" &&
              row.dueDateOverride === null &&
              row.expectedAmountOverrideCents === null,
          )
          .every(
            (row) =>
              row.dueDate <= "2026-12-31" && row.expectedAmountCents === 11000n,
          ),
      ).toBe(true);
      expect(
        rows.filter(
          (row) =>
            row.status === "upcoming" &&
            row.dueDateOverride === null &&
            row.expectedAmountOverrideCents === null,
        ),
      ).toHaveLength(11);
      for (const id of protectedIds)
        expect(rows.find((row) => row.id === id)).toEqual(
          protectedBefore.find((row) => row.id === id),
        );
      await service.updateBill(userId, bill!.id, {
        cadence: "monthly",
        nextExpectedDate: "2026-10-15",
      });
      await materializeBillsForUser(userId, bill!.id, 12, deps);
      rows = await occurrences.listBySetup(userId, bill!.id);
      expect(
        rows.filter(
          (row) =>
            row.status === "upcoming" &&
            row.dueDateOverride === null &&
            row.expectedAmountOverrideCents === null,
        ),
      ).toHaveLength(1);
      expect(rows.find((row) => row.id === october.id)).toMatchObject({
        status: "upcoming",
        expectedAmountCents: 11000n,
        occurrenceKey: `${bill!.id}:2026-10`,
      });
      for (const id of protectedIds)
        expect(rows.find((row) => row.id === id)).toEqual(
          protectedBefore.find((row) => row.id === id),
        );
      events = await db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, userId));
      expect(
        events.find((row) => row.billOccurrenceId === october.id),
      ).toMatchObject({ amount: 11000n, deletedAt: null });
      expect(
        events.filter(
          (row) => row.deletedAt === null && row.date > "2026-12-31",
        ),
      ).toHaveLength(0);
      expect(await repository.findById(userId, bill!.id)).toMatchObject({
        canonicalName: "Original detection",
        cadence: "monthly",
        cadenceOverride: "monthly",
        endDate: "2026-12-31",
      });
      const snapshot = async () => ({
        bill: await repository.findById(userId, bill!.id),
        occurrences: await db
          .select()
          .from(billOccurrences)
          .where(eq(billOccurrences.userId, userId))
          .orderBy(billOccurrences.id),
        events: await db
          .select()
          .from(forecastEvents)
          .where(eq(forecastEvents.userId, userId))
          .orderBy(forecastEvents.id),
      });
      const beforeFailure = await snapshot();
      const failing = createBillsService({
        ...deps,
        repository: {
          ...repository,
          upsertBillForecastEvents: async () => {
            throw new Error("forced failure");
          },
        },
      });
      await expect(
        failing.updateBill(userId, bill!.id, {
          nextExpectedDate: "2026-10-21",
          amountCents: 20000n,
        }),
      ).rejects.toThrow("forced failure");
      expect(await snapshot()).toEqual(beforeFailure);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
  it("replays a changed cadence when all original future cycles were processing or overridden", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb,
        userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const repository = createBillsRepository(db),
        occurrences = createBillOccurrencesRepository(db);
      const deps = {
        repository,
        occurrences,
        now: () => new Date("2026-10-01T12:00:00Z"),
        withUserMutation: async <T>(
          _id: string,
          cb: Parameters<typeof db.transaction<T>>[0],
        ) => db.transaction(cb),
        billDispatcher: { detect: async () => {}, materialize: async () => {} },
      };
      const service = createBillsService(deps);
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Protected cycles",
          cadence: "monthly",
          avgAmount: 8000n,
          nextExpectedDate: "2026-10-15",
          endDate: "2026-11-30",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      await materializeBillsForUser(userId, bill!.id, 2, deps);
      const before = await occurrences.listBySetup(userId, bill!.id);
      await db
        .update(billOccurrences)
        .set({
          status: "processing",
          paidAmountCents: 8000n,
          markedPaidAt: new Date(),
        })
        .where(eq(billOccurrences.id, before[0]!.id));
      await service.updateOccurrence(userId, bill!.id, before[1]!.id, {
        amountCents: 9000n,
        dueDate: "2026-11-19",
      });
      const protectedRows = await occurrences.listBySetup(userId, bill!.id);
      await service.updateBill(userId, bill!.id, {
        cadence: "weekly",
        nextExpectedDate: "2026-10-15",
      });
      await materializeBillsForUser(userId, bill!.id, 12, deps);
      await materializeBillsForUser(userId, bill!.id, 12, deps);
      const rows = await occurrences.listBySetup(userId, bill!.id);
      for (const row of protectedRows)
        expect(rows.find((item) => item.id === row.id)).toEqual(row);
      expect(
        rows.filter(
          (row) => row.status === "upcoming" && row.dueDateOverride === null,
        ),
      ).toHaveLength(5);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
