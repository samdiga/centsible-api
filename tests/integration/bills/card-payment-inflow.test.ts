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

guardedDescribe("card payment bills settled from the card's side", () => {
  it("pays a card bill when the card receives the payment, and only then", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const due = yesterday.toISOString().slice(0, 10);

      const [checking] = await db
        .insert(accounts)
        .values({
          userId,
          name: "BOA Check",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      const cards = await db
        .insert(accounts)
        .values(
          ["Costco", "Refunded", "Short", "Both", "Pending"].map((name) => ({
            userId,
            name,
            type: "credit" as const,
            subtype: "credit_card" as const,
          })),
        )
        .returning();
      const [loan] = await db
        .insert(accounts)
        .values({ userId, name: "Car loan", type: "loan", subtype: "auto" })
        .returning();
      const [costco, refunded, short, both, pendingCard] = cards;

      const bill = async (
        name: string,
        toAccountId: string,
        amount: bigint,
        fields: Partial<typeof billSetup.$inferInsert> = {},
      ) => {
        const [setup] = await db
          .insert(billSetup)
          .values({
            userId,
            canonicalName: name,
            cadence: "monthly",
            avgAmount: amount,
            nextExpectedDate: due,
            status: "active",
            userConfirmed: true,
            billType: "transfer",
            toAccountId,
            accountId: checking!.id,
            ...fields,
          })
          .returning();
        const [occurrence] = await db
          .insert(billOccurrences)
          .values({
            userId,
            billSetupId: setup!.id,
            occurrenceKey: `${setup!.id}:${due}`,
            dueDate: due,
            expectedAmountCents: amount,
            status: "overdue",
          })
          .returning();
        return occurrence!;
      };
      const txn = (
        accountId: string,
        amount: bigint,
        name: string,
        fields: Partial<typeof transactions.$inferInsert> = {},
      ) => ({
        userId,
        accountId,
        amount,
        date: due,
        status: "posted" as const,
        name,
        ...fields,
      });

      // Statement adjusted by the user: the override is what has to arrive.
      const costcoBill = await bill(
        "Costco Anywhere Visa payment",
        costco!.id,
        90000n,
      );
      await db
        .update(billOccurrences)
        .set({ expectedAmountOverrideCents: 101668n })
        .where(eq(billOccurrences.id, costcoBill.id));
      const refundedBill = await bill(
        "Refunded card payment",
        refunded!.id,
        5000n,
      );
      const shortBill = await bill("Short card payment", short!.id, 7000n);
      const bothBill = await bill("Both card payment", both!.id, 8000n);
      const pendingBill = await bill(
        "Pending card payment",
        pendingCard!.id,
        3000n,
      );
      const externalBill = await bill("Car loan payment", loan!.id, 12000n, {
        accountId: null,
        paidFromExternal: true,
      });

      const inserted = await db
        .insert(transactions)
        .values([
          txn(costco!.id, -101668n, "ONLINE PAYMENT, THANK YOU"),
          // A refund on the card is not a payment, whatever its amount.
          txn(refunded!.id, -5000n, "AMAZON MKTPLACE RETURN", {
            plaidCategoryPrimary: "GENERAL_MERCHANDISE",
          }),
          txn(short!.id, -6999n, "PAYMENT RECEIVED"),
          txn(checking!.id, 8000n, "CITI AUTOPAY"),
          txn(both!.id, -8000n, "AUTOPAY PAYMENT", {
            plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
          }),
          txn(pendingCard!.id, -3000n, "PAYMENT - THANK YOU", {
            status: "pending",
            plaidTransactionId: "pending-card-pay",
          }),
          txn(loan!.id, -12000n, "PAYMENT", {
            plaidCategoryPrimary: "TRANSFER_IN",
          }),
        ])
        .returning();
      const id = (name: string, accountId: string) =>
        inserted.find(
          (row) => row.name === name && row.accountId === accountId,
        )!.id;

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

      const rows = await db
        .select()
        .from(billOccurrences)
        .where(eq(billOccurrences.userId, userId));
      const row = (occurrenceId: string) =>
        rows.find((r) => r.id === occurrenceId)!;

      // The card received it and nothing left checking that we can see: paid,
      // from the bill's own paying account, for the adjusted amount.
      expect(row(costcoBill.id)).toMatchObject({
        status: "paid",
        linkedTransactionId: id("ONLINE PAYMENT, THANK YOU", costco!.id),
        paidAccountId: checking!.id,
        paidAmountCents: 101668n,
      });
      expect(row(refundedBill.id)).toMatchObject({
        status: "overdue",
        linkedTransactionId: null,
      });
      expect(row(shortBill.id)).toMatchObject({
        status: "overdue",
        linkedTransactionId: null,
      });
      // Both sides visible: the paying side is linked, once.
      expect(row(bothBill.id)).toMatchObject({
        status: "paid",
        linkedTransactionId: id("CITI AUTOPAY", checking!.id),
      });
      expect(
        rows.filter(
          (r) => r.linkedTransactionId === id("AUTOPAY PAYMENT", both!.id),
        ),
      ).toHaveLength(0);
      // Pending on the card holds the bill, as a pending debit does.
      expect(row(pendingBill.id)).toMatchObject({
        status: "processing",
        pendingTransactionId: id("PAYMENT - THANK YOU", pendingCard!.id),
      });
      // Paid from outside Centsy: the loan's side is all there is.
      expect(row(externalBill.id)).toMatchObject({
        status: "paid",
        linkedTransactionId: id("PAYMENT", loan!.id),
        paidAccountId: null,
        paidAmountCents: 12000n,
      });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
