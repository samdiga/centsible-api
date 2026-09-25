import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ConflictError } from "../../../src/platform/errors/app-error.js";
import { describe, expect, it, vi } from "vitest";
import {
  accounts,
  billOccurrences,
  billSetup,
  forecastEvents,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import {
  createBillWorkerLifecycle,
  createBillsService,
  materializeBillsForUser,
} from "../../../src/modules/bills/bills.service.js";
import { upsertStatementBills } from "../../../src/modules/bills/statement-bills.js";
import type { DbTransaction } from "../../../src/platform/database/types.js";
import { createUserMutationService } from "../../../src/platform/cache/user-revisions.repository.js";
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

guardedDescribe("bills repositories", () => {
  it("rejects a forecast identity date collision without changing the occurrence or linked event", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [bill] = await testDb.db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Electric bill",
          cadence: "monthly",
          avgAmount: 12500n,
          nextExpectedDate: "2026-10-01",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const [occurrence] = await testDb.db
        .insert(billOccurrences)
        .values({
          userId,
          billSetupId: bill!.id,
          occurrenceKey: `${bill!.id}:2026-10`,
          dueDate: "2026-10-01",
          expectedAmountCents: 12500n,
        })
        .returning();
      const [linked] = await testDb.db
        .insert(forecastEvents)
        .values({
          userId,
          name: "Electric bill",
          amount: 12500n,
          date: "2026-10-01",
          recurringSeriesId: bill!.id,
          billOccurrenceId: occurrence!.id,
          sourceType: "recurring",
        })
        .returning();
      await testDb.db.insert(forecastEvents).values({
        userId,
        name: "Legacy recurring forecast",
        amount: 12500n,
        date: "2026-10-15",
        recurringSeriesId: bill!.id,
        sourceType: "recurring",
      });
      const cache = { invalidateUser: vi.fn() };
      const userMutation = createUserMutationService({
        db: testDb.db,
        cache,
        incrementRevision: async () => 1n,
        publishInvalidation: async () => undefined,
      });
      const service = createBillsService({
        repository: createBillsRepository(testDb.db),
        occurrences: createBillOccurrencesRepository(testDb.db),
        withUserMutation: userMutation.withUserMutation,
      });

      await expect(
        service.updateOccurrence(userId, bill!.id, occurrence!.id, {
          dueDate: "2026-10-15",
          amountCents: 14000n,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      const [afterOccurrence] = await testDb.db
        .select()
        .from(billOccurrences)
        .where(eq(billOccurrences.id, occurrence!.id));
      const [afterForecast] = await testDb.db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.id, linked!.id));
      expect(afterOccurrence).toMatchObject({
        dueDate: "2026-10-01",
        dueDateOverride: null,
        expectedAmountOverrideCents: null,
      });
      expect(afterForecast).toMatchObject({
        date: "2026-10-01",
        amount: 12500n,
      });
      expect(cache.invalidateUser).not.toHaveBeenCalled();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("lists setup occurrence history oldest first and atomically rejects a second terminal transition", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [bill] = await testDb.db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Rent",
          cadence: "monthly",
          avgAmount: 100n,
          nextExpectedDate: "2026-10-01",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      await testDb.db.insert(billOccurrences).values([
        {
          userId,
          billSetupId: bill!.id,
          occurrenceKey: `${bill!.id}:2026-09`,
          dueDate: "2026-09-01",
          expectedAmountCents: 100n,
        },
        {
          userId,
          billSetupId: bill!.id,
          occurrenceKey: `${bill!.id}:2026-10`,
          dueDate: "2026-10-01",
          expectedAmountCents: 100n,
        },
      ]);
      const occurrences = createBillOccurrencesRepository(testDb.db);
      const history = await occurrences.listBySetup(userId, bill!.id);
      expect(history.map((row) => row.dueDate)).toEqual([
        "2026-09-01",
        "2026-10-01",
      ]);
      expect(
        await occurrences.updateIfStatus(userId, history[0]!.id, ["upcoming"], {
          status: "skipped",
        }),
      ).not.toBeNull();
      await expect(
        occurrences.updateIfStatus(userId, history[0]!.id, ["upcoming"], {
          status: "processing",
        }),
      ).resolves.toBeNull();
      await expect(
        createBillsRepository(testDb.db).findById(userId, bill!.id),
      ).resolves.toMatchObject({ id: bill!.id });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("keeps monthly cycle and event IDs while refreshing baselines around occurrence overrides", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [bill] = await testDb.db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Card payment",
          cadence: "monthly",
          avgAmount: 100n,
          nextExpectedDate: "2026-10-15",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const bills = createBillsRepository(testDb.db);
      const occurrences = createBillOccurrencesRepository(testDb.db);
      const mutate = async <T>(
        _userId: string,
        callback: (tx: DbTransaction) => Promise<T>,
      ): Promise<T> => testDb.db.transaction(callback);
      const refresh = () =>
        materializeBillsForUser(userId, bill!.id, 1, {
          repository: bills,
          occurrences,
          withUserMutation: mutate,
          now: () => new Date("2026-10-01T12:00:00.000Z"),
        });
      await refresh();
      const [first] = await occurrences.listBySetup(userId, bill!.id);
      const [firstEvent] = await testDb.db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.billOccurrenceId, first!.id));
      expect(firstEvent).toMatchObject({ date: "2026-10-15", amount: 100n });
      await testDb.db
        .update(billOccurrences)
        .set({
          expectedAmountOverrideCents: 170n,
          dueDateOverride: "2026-10-22",
        })
        .where(eq(billOccurrences.id, first!.id));
      await testDb.db
        .update(billSetup)
        .set({ avgAmount: 125n, nextExpectedDate: "2026-10-20" })
        .where(eq(billSetup.id, bill!.id));
      await refresh();
      await refresh();
      const rows = await occurrences.listBySetup(userId, bill!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: first!.id,
        occurrenceKey: `${bill!.id}:2026-10`,
        dueDate: "2026-10-20",
        expectedAmountCents: 125n,
        dueDateOverride: "2026-10-22",
        expectedAmountOverrideCents: 170n,
      });
      const events = await testDb.db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.billOccurrenceId, first!.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: firstEvent!.id,
        date: "2026-10-22",
        amount: 170n,
      });
      await testDb.db
        .update(billOccurrences)
        .set({ dueDateOverride: null })
        .where(eq(billOccurrences.id, first!.id));
      await testDb.db
        .update(billSetup)
        .set({ avgAmount: 130n, nextExpectedDate: "2026-10-21" })
        .where(eq(billSetup.id, bill!.id));
      await refresh();
      expect(
        (
          await testDb.db
            .select()
            .from(forecastEvents)
            .where(eq(forecastEvents.billOccurrenceId, first!.id))
        )[0],
      ).toMatchObject({ id: firstEvent!.id, date: "2026-10-21", amount: 170n });
      await testDb.db
        .update(billOccurrences)
        .set({
          expectedAmountOverrideCents: null,
          dueDateOverride: "2026-10-25",
        })
        .where(eq(billOccurrences.id, first!.id));
      await testDb.db
        .update(billSetup)
        .set({ avgAmount: 140n, nextExpectedDate: "2026-10-24" })
        .where(eq(billSetup.id, bill!.id));
      await refresh();
      expect(
        (
          await testDb.db
            .select()
            .from(forecastEvents)
            .where(eq(forecastEvents.billOccurrenceId, first!.id))
        )[0],
      ).toMatchObject({ id: firstEvent!.id, date: "2026-10-25", amount: 140n });
      await testDb.db
        .update(billOccurrences)
        .set({ status: "paid" })
        .where(eq(billOccurrences.id, first!.id));
      await testDb.db
        .update(billSetup)
        .set({ avgAmount: 150n, nextExpectedDate: "2026-10-26" })
        .where(eq(billSetup.id, bill!.id));
      await refresh();
      expect(
        (await occurrences.listBySetup(userId, bill!.id))[0],
      ).toMatchObject({
        id: first!.id,
        status: "paid",
        dueDate: "2026-10-24",
        expectedAmountCents: 140n,
      });
      expect(
        (
          await testDb.db
            .select()
            .from(forecastEvents)
            .where(eq(forecastEvents.billOccurrenceId, first!.id))
        )[0],
      ).toMatchObject({ id: firstEvent!.id, date: "2026-10-25", amount: 140n });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("refreshes an existing current-month cycle after its new due date passes, without creating a new past cycle", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [existingBill, freshBill] = await testDb.db
        .insert(billSetup)
        .values([
          {
            userId,
            canonicalName: "Existing cycle",
            cadence: "monthly",
            avgAmount: 100n,
            nextExpectedDate: "2026-10-20",
            status: "active",
            userConfirmed: true,
          },
          {
            userId,
            canonicalName: "Fresh cycle",
            cadence: "monthly",
            avgAmount: 200n,
            nextExpectedDate: "2026-10-10",
            status: "active",
            userConfirmed: true,
          },
        ])
        .returning();
      const bills = createBillsRepository(testDb.db);
      const occurrences = createBillOccurrencesRepository(testDb.db);
      const mutate = async <T>(
        _userId: string,
        callback: (tx: DbTransaction) => Promise<T>,
      ): Promise<T> => testDb.db.transaction(callback);
      const refresh = (billId: string) =>
        materializeBillsForUser(userId, billId, 1, {
          repository: bills,
          occurrences,
          withUserMutation: mutate,
          now: () => new Date("2026-10-15T12:00:00.000Z"),
        });
      await refresh(existingBill!.id);
      const [original] = await occurrences.listBySetup(
        userId,
        existingBill!.id,
      );
      const [originalEvent] = await testDb.db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.billOccurrenceId, original!.id));
      await testDb.db
        .update(billSetup)
        .set({ nextExpectedDate: "2026-10-10", avgAmount: 125n })
        .where(eq(billSetup.id, existingBill!.id));
      await refresh(existingBill!.id);
      const october = (
        await occurrences.listBySetup(userId, existingBill!.id)
      ).filter((row) => row.occurrenceKey === `${existingBill!.id}:2026-10`);
      expect(october).toHaveLength(1);
      expect(october[0]).toMatchObject({
        id: original!.id,
        dueDate: "2026-10-10",
        expectedAmountCents: 125n,
      });
      expect(
        (
          await testDb.db
            .select()
            .from(forecastEvents)
            .where(eq(forecastEvents.billOccurrenceId, original!.id))
        )[0],
      ).toMatchObject({
        id: originalEvent!.id,
        date: "2026-10-10",
        amount: 125n,
      });
      await refresh(freshBill!.id);
      expect(
        (await occurrences.listBySetup(userId, freshBill!.id)).filter(
          (row) => row.occurrenceKey === `${freshBill!.id}:2026-10`,
        ),
      ).toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("keeps linked forecast events distinct when two cycles share an effective date", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [bill] = await testDb.db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Same-date cycles",
          cadence: "monthly",
          avgAmount: 100n,
          nextExpectedDate: "2026-10-20",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const bills = createBillsRepository(testDb.db);
      const occurrences = createBillOccurrencesRepository(testDb.db);
      const mutate = async <T>(
        _userId: string,
        callback: (tx: DbTransaction) => Promise<T>,
      ): Promise<T> => testDb.db.transaction(callback);
      const refresh = () =>
        materializeBillsForUser(userId, bill!.id, 2, {
          repository: bills,
          occurrences,
          withUserMutation: mutate,
          now: () => new Date("2026-10-01T12:00:00.000Z"),
        });
      await refresh();
      const rows = await occurrences.listBySetup(userId, bill!.id);
      expect(rows).toHaveLength(2);
      await testDb.db
        .update(billOccurrences)
        .set({ dueDateOverride: "2026-10-20" })
        .where(eq(billOccurrences.id, rows[1]!.id));
      await refresh();
      const linked = await testDb.db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.recurringSeriesId, bill!.id));
      expect(linked).toHaveLength(2);
      expect(linked.map((row) => row.date)).toEqual([
        "2026-10-20",
        "2026-10-20",
      ]);
      expect(new Set(linked.map((row) => row.billOccurrenceId))).toEqual(
        new Set(rows.map((row) => row.id)),
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("creates, updates, and does not resurrect statement transfer bills", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherUserId = randomUUID();
      await testDb.db.insert(users).values([
        { id: userId, email: `${userId}@example.test` },
        { id: otherUserId, email: `${otherUserId}@example.test` },
      ]);
      const [account] = await testDb.db
        .insert(accounts)
        .values({
          userId,
          name: "Visa",
          type: "credit",
          subtype: "credit_card",
          statementBalance: 12500n,
          paymentDueDate: "2026-10-15",
        })
        .returning();
      await testDb.db.insert(accounts).values({
        userId: otherUserId,
        name: "Visa",
        type: "credit",
        subtype: "credit_card",
        statementBalance: 9900n,
        paymentDueDate: "2026-10-15",
      });
      const mutate = async <T>(
        _tenantId: string,
        callback: (tx: DbTransaction) => Promise<T>,
      ): Promise<T> => testDb.db.transaction(callback);

      await expect(
        upsertStatementBills(userId, {
          db: testDb.db,
          withUserMutation: mutate,
        }),
      ).resolves.toEqual({ created: 1, updated: 0 });
      const [created] = await testDb.db
        .select()
        .from(billSetup)
        .where(eq(billSetup.userId, userId));
      expect(created).toMatchObject({
        canonicalName: "Visa payment",
        billType: "transfer",
        toAccountId: account!.id,
        avgAmount: 12500n,
      });

      await testDb.db
        .update(accounts)
        .set({ statementBalance: 15000n, paymentDueDate: "2026-10-20" })
        .where(eq(accounts.id, account!.id));
      await expect(
        upsertStatementBills(userId, {
          db: testDb.db,
          withUserMutation: mutate,
        }),
      ).resolves.toEqual({ created: 0, updated: 1 });

      await testDb.db
        .update(billSetup)
        .set({ deletedAt: new Date() })
        .where(eq(billSetup.id, created!.id));
      await expect(
        upsertStatementBills(userId, {
          db: testDb.db,
          withUserMutation: mutate,
        }),
      ).resolves.toEqual({ created: 0, updated: 0 });
      await expect(
        testDb.db
          .select({ deletedAt: billSetup.deletedAt })
          .from(billSetup)
          .where(eq(billSetup.id, created!.id)),
      ).resolves.toMatchObject([{ deletedAt: expect.any(Date) }]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("dispatches manual materialization, materializes daily cadence, and runs worker lifecycle operations", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const bills = createBillsRepository(testDb.db);
      const occurrences = createBillOccurrencesRepository(testDb.db);
      const mutate = async <T>(
        _tenantId: string,
        callback: (tx: DbTransaction) => Promise<T>,
      ): Promise<T> => testDb.db.transaction(callback);
      const materialize = vi.fn(async () => undefined);
      const service = createBillsService({
        repository: bills,
        occurrences,
        withUserMutation: mutate,
        getUserRevision: async () => 0n,
        cache: {
          getOrCompute: async (_key, compute) => compute(),
          invalidateUser: () => undefined,
        },
        billDispatcher: {
          detect: async () => undefined,
          materialize,
        },
      });

      const created = await service.createBill(userId, {
        canonicalName: "Rent",
        amountCents: 180000n,
        cadence: "monthly",
        nextExpectedDate: "2026-10-01",
        isIncome: false,
        billType: "payable",
      });
      await service.updateBill(userId, created.id, { userConfirmed: true });
      expect(materialize).toHaveBeenCalledTimes(2);

      const [daily] = await testDb.db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Daily transit",
          cadence: "daily",
          avgAmount: 250n,
          nextExpectedDate: "2026-09-01",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      await expect(
        materializeBillsForUser(userId, daily!.id, 1, {
          repository: bills,
          occurrences,
          withUserMutation: mutate,
          now: () => new Date("2026-09-01T12:00:00.000Z"),
        }),
      ).resolves.toEqual({ setupsMaterialized: 1, occurrencesCreated: 31 });
      const lifecycle = createBillWorkerLifecycle({
        repository: bills,
        occurrences,
        withUserMutation: mutate,
      });
      await lifecycle.detect(userId);
      await lifecycle.sweepOverdue(userId);
      await lifecycle.resolveMaturedForecastEvents(userId);
      await expect(
        service.listOccurrences(userId, randomUUID()),
      ).resolves.toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
