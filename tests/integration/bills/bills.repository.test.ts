import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ConflictError } from "../../../src/platform/errors/app-error.js";
import { describe, expect, it, vi } from "vitest";
import {
  accounts,
  auditLog,
  billOccurrences,
  billSetup,
  forecastEvents,
  users,
  transactions,
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
  it("auto-confirms only exact posted outflows from live checking and savings accounts and is replay safe", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherUserId = randomUUID();
      await testDb.db.insert(users).values([
        { id: userId, email: `${userId}@example.test` },
        { id: otherUserId, email: `${otherUserId}@example.test` },
      ]);
      const accountSeeds = [
        {
          key: "checking",
          userId,
          type: "depository" as const,
          subtype: "checking" as const,
        },
        {
          key: "savings",
          userId,
          type: "depository" as const,
          subtype: "savings" as const,
        },
        {
          key: "deleted",
          userId,
          type: "depository" as const,
          subtype: "checking" as const,
          deleted: true,
        },
        {
          key: "credit",
          userId,
          type: "credit" as const,
          subtype: "credit_card" as const,
        },
        {
          key: "loan",
          userId,
          type: "loan" as const,
          subtype: "personal_loan" as const,
        },
        {
          key: "other-subtype",
          userId,
          type: "depository" as const,
          subtype: "money_market" as const,
        },
        {
          key: "other-type",
          userId,
          type: "other" as const,
          subtype: "checking" as const,
        },
        {
          key: "cross-tenant",
          userId: otherUserId,
          type: "depository" as const,
          subtype: "checking" as const,
        },
      ];
      const insertedAccounts = await testDb.db
        .insert(accounts)
        .values(
          accountSeeds.map(
            ({ key, userId: owner, type, subtype, deleted }) => ({
              userId: owner,
              name: key,
              type,
              subtype,
              ...(deleted ? { deletedAt: new Date() } : {}),
            }),
          ),
        )
        .returning();
      const accountByKey = new Map(
        accountSeeds.map(
          (seed, index) => [seed.key, insertedAccounts[index]!] as const,
        ),
      );
      const [bill] = await testDb.db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Exact match fixture",
          cadence: "monthly",
          avgAmount: 1000n,
          nextExpectedDate: "2026-09-25",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const transactionSeeds = [
        {
          key: "valid",
          account: "checking",
          amount: 1000n,
          status: "posted" as const,
        },
        {
          key: "pending",
          account: "checking",
          amount: 2000n,
          status: "pending" as const,
        },
        {
          key: "deleted-transaction",
          account: "checking",
          amount: 3000n,
          status: "posted" as const,
          deleted: true,
        },
        {
          key: "deleted-account",
          account: "deleted",
          amount: 4000n,
          status: "posted" as const,
        },
        {
          key: "credit",
          account: "credit",
          amount: 5000n,
          status: "posted" as const,
        },
        {
          key: "loan",
          account: "loan",
          amount: 6000n,
          status: "posted" as const,
        },
        {
          key: "other-subtype",
          account: "other-subtype",
          amount: 7000n,
          status: "posted" as const,
        },
        {
          key: "inflow",
          account: "checking",
          amount: -8000n,
          status: "posted" as const,
        },
        {
          key: "cross-tenant",
          account: "cross-tenant",
          amount: 9000n,
          status: "posted" as const,
          owner: otherUserId,
        },
        {
          key: "savings-valid",
          account: "savings",
          amount: 10000n,
          status: "posted" as const,
        },
        {
          key: "other-type",
          account: "other-type",
          amount: 11000n,
          status: "posted" as const,
        },
      ];
      const dates = transactionSeeds.map((_, index) =>
        new Date(Date.UTC(2026, 8, 25 + index)).toISOString().slice(0, 10),
      );
      const insertedTransactions = await testDb.db
        .insert(transactions)
        .values(
          transactionSeeds.map(
            ({ key, account, amount, status, deleted, owner }, index) => ({
              userId: owner ?? userId,
              accountId: accountByKey.get(account)!.id,
              amount,
              date: index === 0 ? "2026-09-18" : dates[index]!,
              status,
              name: key,
              ...(deleted ? { deletedAt: new Date() } : {}),
            }),
          ),
        )
        .returning();
      const transactionByKey = new Map(
        transactionSeeds.map(
          (seed, index) => [seed.key, insertedTransactions[index]!] as const,
        ),
      );
      const statuses = [
        "processing",
        "upcoming",
        "overdue",
        "upcoming",
        "processing",
        "overdue",
        "upcoming",
        "processing",
        "overdue",
        "upcoming",
        "processing",
      ] as const;
      const occurrences = await testDb.db
        .insert(billOccurrences)
        .values(
          transactionSeeds.map((seed, index) => ({
            userId,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:match-${seed.key}`,
            dueDate: dates[index]!,
            expectedAmountCents: seed.key === "inflow" ? 8000n : seed.amount,
            status: statuses[index]!,
          })),
        )
        .returning();
      const validOccurrences = [occurrences[0]!, occurrences[9]!];
      await testDb.db.insert(forecastEvents).values(
        validOccurrences.map((row) => ({
          userId,
          name: "Exact match fixture",
          amount: row.expectedAmountCents,
          date: row.dueDate,
          recurringSeriesId: bill!.id,
          billOccurrenceId: row.id,
          sourceType: "recurring" as const,
        })),
      );
      const cache = { invalidateUser: vi.fn() };
      const mutation = createUserMutationService({
        db: testDb.db,
        cache,
        incrementRevision: async () => 1n,
        publishInvalidation: async () => undefined,
      });
      const service = createBillWorkerLifecycle({
        repository: createBillsRepository(testDb.db),
        occurrences: createBillOccurrencesRepository(testDb.db),
        withUserMutation: mutation.withUserMutation,
      });

      await service.resolveMaturedForecastEvents(userId);
      await service.resolveMaturedForecastEvents(userId);

      const after = await testDb.db
        .select()
        .from(billOccurrences)
        .where(eq(billOccurrences.billSetupId, bill!.id));
      expect(
        after.find(({ id }) => id === validOccurrences[0]!.id),
      ).toMatchObject({
        status: "paid",
        linkedTransactionId: transactionByKey.get("valid")!.id,
        paidAccountId: accountByKey.get("checking")!.id,
        paidAmountCents: 1000n,
      });
      expect(
        after.find(({ id }) => id === validOccurrences[1]!.id),
      ).toMatchObject({
        status: "paid",
        linkedTransactionId: transactionByKey.get("savings-valid")!.id,
        paidAccountId: accountByKey.get("savings")!.id,
        paidAmountCents: 10000n,
      });
      for (const row of after.filter(
        ({ id }) => !validOccurrences.some((valid) => valid.id === id),
      )) {
        expect(row.status).toBe(
          statuses[occurrences.findIndex(({ id }) => id === row.id)],
        );
        expect(row.linkedTransactionId).toBeNull();
      }
      const linkedForecast = await testDb.db
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, userId));
      expect(linkedForecast).toHaveLength(2);
      expect(
        linkedForecast.every(
          ({ resolvedToTransactionId }) => resolvedToTransactionId !== null,
        ),
      ).toBe(true);
      const audits = await testDb.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, userId));
      expect(audits).toHaveLength(2);
      expect(
        audits.every(
          ({ source, action }) =>
            source === "bills.auto_confirm_paid" && action === "update",
        ),
      ).toBe(true);
      expect(audits[0]).toMatchObject({
        action: "update",
        source: "bills.auto_confirm_paid",
      });
    } finally {
      await testDb.cleanup();
    }
  }, 30_000);

  it("uses effective dates for current occurrence selection, month views, and overdue sweeps", async () => {
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
          canonicalName: "Monthly service",
          cadence: "monthly",
          avgAmount: 100n,
          nextExpectedDate: "2026-10-01",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      const [baselineEarlier, overrideEarlier] = await testDb.db
        .insert(billOccurrences)
        .values([
          {
            userId,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:baseline-earlier`,
            dueDate: "2026-10-01",
            dueDateOverride: "2026-11-01",
            expectedAmountCents: 100n,
          },
          {
            userId,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:override-earlier`,
            dueDate: "2026-10-10",
            dueDateOverride: "2026-09-30",
            expectedAmountCents: 100n,
          },
        ])
        .returning();
      const occurrences = createBillOccurrencesRepository(testDb.db);
      const bills = createBillsRepository(testDb.db);
      const service = createBillsService({
        repository: bills,
        occurrences,
        getUserRevision: async () => 1n,
      });

      await expect(
        occurrences.currentForSetup(userId, bill!.id),
      ).resolves.toMatchObject({
        id: overrideEarlier!.id,
      });
      await expect(service.listBills(userId, "2026-09")).resolves.toMatchObject(
        {
          series: [
            {
              id: bill!.id,
              currentOccurrence: {
                id: overrideEarlier!.id,
                dueDate: "2026-09-30",
              },
            },
          ],
        },
      );

      const [overrideAlreadyDue, baselineAlreadyDue] = await testDb.db
        .insert(billOccurrences)
        .values([
          {
            userId,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:override-past`,
            dueDate: "2099-01-01",
            dueDateOverride: "2000-01-01",
            expectedAmountCents: 100n,
          },
          {
            userId,
            billSetupId: bill!.id,
            occurrenceKey: `${bill!.id}:baseline-past`,
            dueDate: "2000-01-01",
            dueDateOverride: "2099-01-01",
            expectedAmountCents: 100n,
          },
        ])
        .returning();

      await expect(occurrences.sweepOverdue(userId)).resolves.toBe(1);
      const afterSweep = await occurrences.listBySetup(userId, bill!.id);
      expect(
        afterSweep.find(({ id }) => id === overrideAlreadyDue!.id)?.status,
      ).toBe("overdue");
      expect(
        afterSweep.find(({ id }) => id === baselineAlreadyDue!.id)?.status,
      ).toBe("upcoming");
      expect(
        afterSweep.find(({ id }) => id === baselineEarlier!.id)?.status,
      ).toBe("upcoming");
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

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
