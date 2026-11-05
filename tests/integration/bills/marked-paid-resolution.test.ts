import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

const daysAgo = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
};
const day = (date: Date) => date.toISOString().slice(0, 10);

guardedDescribe("bills marked paid that no payment matches exactly", () => {
  it("confirms against a card payment of at least the marked amount, and closes the rest as marked after 10 days", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db.insert(users).values({ id: userId, email: `${userId}@example.test` });
      const [checking] = await db
        .insert(accounts)
        .values({ userId, name: "BOA Check", type: "depository", subtype: "checking" })
        .returning();
      const cards = await db
        .insert(accounts)
        .values(
          ["Savor", "Cash Rewards", "Recent", "Scheduled", "Gap Encore"].map((name) => ({
            userId,
            name,
            type: "credit" as const,
            subtype: "credit_card" as const,
          })),
        )
        .returning();
      const [savor, cashRewards, recent, scheduled, gap] = cards;

      /** A card bill the user marked paid `marked` days ago, due `due` days ago. */
      const markedBill = async (
        card: { id: string; name: string },
        expected: bigint,
        paid: bigint,
        due: number,
        marked: number,
        paidAccountId = checking!.id,
      ) => {
        const [setup] = await db
          .insert(billSetup)
          .values({
            userId,
            canonicalName: `${card.name} payment`,
            cadence: "monthly",
            avgAmount: expected,
            status: "active",
            userConfirmed: true,
            billType: "transfer",
            toAccountId: card.id,
            accountId: checking!.id,
          })
          .returning();
        const [occurrence] = await db
          .insert(billOccurrences)
          .values({
            userId,
            billSetupId: setup!.id,
            occurrenceKey: `${setup!.id}:${day(daysAgo(due))}`,
            dueDate: day(daysAgo(due)),
            expectedAmountCents: expected,
            ...(paid !== expected ? { expectedAmountOverrideCents: paid } : {}),
            status: "processing",
            paidAmountCents: paid,
            paidAccountId,
            markedPaidAt: daysAgo(marked),
          })
          .returning();
        return occurrence!;
      };

      // Savor: marked $528.14 on the due date; $621.14 arrived that day.
      const savorBill = await markedBill(savor!, 52814n, 52814n, 3, 3);
      // Cash Rewards: marked $1,000 of $11,500 from another card, 20 days
      // ago; only an unrelated $500 ever arrived.
      const cashRewardsBill = await markedBill(cashRewards!, 1150000n, 100000n, 20, 20, gap!.id);
      // Marked 5 days ago: still waiting.
      const recentBill = await markedBill(recent!, 20000n, 20000n, 5, 5);
      // Marked 15 days ago for a due date 5 days ago: waits from the due date.
      const scheduledBill = await markedBill(scheduled!, 30000n, 30000n, 5, 15);

      const [savorPayment] = await db
        .insert(transactions)
        .values([
          {
            userId,
            accountId: savor!.id,
            amount: -62114n,
            date: day(daysAgo(3)),
            status: "posted" as const,
            name: "PAYMENT RECEIVED",
            plaidCategoryPrimary: "LOAN_PAYMENTS",
          },
          {
            userId,
            accountId: cashRewards!.id,
            amount: -50000n,
            date: day(daysAgo(22)),
            status: "posted" as const,
            name: "PAYMENT RECEIVED",
            plaidCategoryPrimary: "TRANSFER_IN",
          },
        ])
        .returning();

      const mutation = createUserMutationService({
        db,
        cache: { invalidateUser: vi.fn() },
        incrementRevision: async () => 1n,
        publishInvalidation: async () => undefined,
      });
      await createBillWorkerLifecycle({
        repository: createBillsRepository(db),
        occurrences: createBillOccurrencesRepository(db),
        withUserMutation: mutation.withUserMutation,
      }).resolveMaturedForecastEvents(userId);

      const rows = await db.select().from(billOccurrences).where(eq(billOccurrences.userId, userId));
      const row = (id: string) => rows.find((r) => r.id === id)!;

      expect(row(savorBill.id)).toMatchObject({
        status: "paid",
        linkedTransactionId: savorPayment!.id,
        paidAmountCents: 62114n,
      });
      // The mark stands: paid for what was marked; the rest is next statement's.
      expect(row(cashRewardsBill.id)).toMatchObject({
        status: "paid",
        linkedTransactionId: null,
        paidAmountCents: 100000n,
        paidAccountId: gap!.id,
      });
      expect(row(cashRewardsBill.id).confirmedPaidAt).not.toBeNull();
      expect(row(recentBill.id)).toMatchObject({ status: "processing", confirmedPaidAt: null });
      expect(row(scheduledBill.id)).toMatchObject({ status: "processing", confirmedPaidAt: null });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
