import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  accounts,
  billOccurrences,
  billSetup,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
import { createBillWorkerLifecycle } from "../../../src/modules/bills/bills.service.js";
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

guardedDescribe("pending bill payments", () => {
  it("soft-links pending charges, confirms replacements or other posted charges, and restores removed charges", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [card] = await testDb.db
        .insert(accounts)
        .values({
          userId,
          name: "Card",
          type: "credit",
          subtype: "credit_card",
        })
        .returning();
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const dueDate = yesterday.toISOString().slice(0, 10);
      const amounts = [2131n, 3210n, 4433n, 5555n, 6666n, 6666n];
      const setups = await testDb.db
        .insert(billSetup)
        .values(
          amounts.map((amount, index) => ({
            userId,
            canonicalName: `Bill ${index}`,
            cadence: "monthly" as const,
            avgAmount: amount,
            nextExpectedDate: dueDate,
            accountId: card!.id,
            status: "active" as const,
            userConfirmed: true,
          })),
        )
        .returning();
      const occurrences = await testDb.db
        .insert(billOccurrences)
        .values(
          setups.map((setup, index) => ({
            userId,
            billSetupId: setup.id,
            occurrenceKey: `${setup.id}:${dueDate}`,
            dueDate,
            expectedAmountCents: amounts[index]!,
            status: "upcoming" as const,
          })),
        )
        .returning();
      const pending = await testDb.db
        .insert(transactions)
        .values(
          [0, 1, 2, 4].map((index) => ({
            userId,
            accountId: card!.id,
            amount: amounts[index]!,
            date: dueDate,
            status: "pending" as const,
            name: `Pending ${index}`,
            plaidTransactionId: `pending-${index}`,
          })),
        )
        .returning();
      const [postedFirst] = await testDb.db
        .insert(transactions)
        .values({
          userId,
          accountId: card!.id,
          amount: amounts[3]!,
          date: dueDate,
          status: "posted",
          name: "Posted before pending matching",
        })
        .returning();
      const mutation = createUserMutationService({
        db: testDb.db,
        cache: { invalidateUser: vi.fn() },
        incrementRevision: async () => 1n,
        publishInvalidation: async () => undefined,
      });
      const worker = createBillWorkerLifecycle({
        repository: createBillsRepository(testDb.db),
        occurrences: createBillOccurrencesRepository(testDb.db),
        withUserMutation: mutation.withUserMutation,
      });

      await worker.resolveMaturedForecastEvents(userId);
      const first = await testDb.db
        .select()
        .from(billOccurrences)
        .where(eq(billOccurrences.userId, userId));
      for (const index of [0, 1, 2]) {
        expect(
          first.find((row) => row.id === occurrences[index]!.id),
        ).toMatchObject({
          status: "processing",
          pendingTransactionId: pending[index]!.id,
          linkedTransactionId: null,
        });
      }
      expect(first.find((row) => row.id === occurrences[3]!.id)).toMatchObject({
        status: "paid",
        pendingTransactionId: null,
        linkedTransactionId: postedFirst!.id,
      });
      for (const index of [4, 5]) {
        expect(
          first.find((row) => row.id === occurrences[index]!.id),
        ).toMatchObject({
          status: "upcoming",
          pendingTransactionId: null,
        });
      }

      await testDb.db
        .update(transactions)
        .set({ status: "removed", deletedAt: new Date() })
        .where(inArray(transactions.id, [pending[0]!.id, pending[1]!.id]));
      const posted = await testDb.db
        .insert(transactions)
        .values([
          {
            userId,
            accountId: card!.id,
            amount: amounts[0]!,
            date: dueDate,
            status: "posted" as const,
            name: "Posted replacement",
            plaidRawPayload: { pending_transaction_id: "pending-0" },
          },
          {
            userId,
            accountId: card!.id,
            amount: amounts[2]!,
            date: dueDate,
            status: "posted" as const,
            name: "Different posted charge",
          },
        ])
        .returning();
      await worker.resolveMaturedForecastEvents(userId);
      const second = await testDb.db
        .select()
        .from(billOccurrences)
        .where(eq(billOccurrences.userId, userId));
      expect(second.find((row) => row.id === occurrences[0]!.id)).toMatchObject(
        {
          status: "paid",
          pendingTransactionId: null,
          linkedTransactionId: posted[0]!.id,
        },
      );
      expect(second.find((row) => row.id === occurrences[1]!.id)).toMatchObject(
        {
          status: "overdue",
          pendingTransactionId: null,
          linkedTransactionId: null,
        },
      );
      expect(second.find((row) => row.id === occurrences[2]!.id)).toMatchObject(
        {
          status: "paid",
          pendingTransactionId: null,
          linkedTransactionId: posted[1]!.id,
        },
      );
    } finally {
      await testDb.cleanup();
    }
  }, 30_000);
});
