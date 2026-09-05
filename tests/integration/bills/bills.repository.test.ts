import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  accounts,
  billOccurrences,
  billSetup,
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
          dueDate: "2026-09-01",
          expectedAmountCents: 100n,
        },
        {
          userId,
          billSetupId: bill!.id,
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
        dispatcher: {
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
