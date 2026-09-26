import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  plaidItems,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
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

guardedDescribe("linked transaction summaries", () => {
  it("returns name, date and amount only for the caller's own transactions", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const owner = randomUUID();
      const other = randomUUID();
      await db.insert(users).values([
        { id: owner, email: `${owner}@example.test`, name: "Owner" },
        { id: other, email: `${other}@example.test`, name: "Other" },
      ]);
      const txnFor = async (
        userId: string,
        fields: Partial<typeof transactions.$inferInsert>,
      ) => {
        const [item] = await db
          .insert(plaidItems)
          .values({
            userId,
            plaidItemId: `pi-${randomUUID()}`,
            institutionId: "ins",
            institutionName: "Bank",
            accessTokenEncrypted: "e",
            accessTokenNonce: "n",
          })
          .returning();
        const [account] = await db
          .insert(accounts)
          .values({
            userId,
            plaidItemId: item!.id,
            plaidAccountId: `pa-${randomUUID()}`,
            name: "Checking",
            type: "depository",
            subtype: "checking",
            currency: "USD",
          })
          .returning();
        return (
          await db
            .insert(transactions)
            .values({
              userId,
              accountId: account!.id,
              amount: 45000n,
              currency: "USD",
              date: "2026-10-01",
              name: "ACH PAYMENT",
              status: "posted",
              ...fields,
            })
            .returning()
        )[0]!;
      };
      const mine = await txnFor(owner, { merchantName: "Capital One" });
      const nameOnly = await txnFor(owner, {
        merchantName: null,
        name: "AMEX EPAYMENT",
      });
      const theirs = await txnFor(other, { merchantName: "Someone Else" });

      const summaries = await createBillOccurrencesRepository(
        db,
      ).linkedTransactionSummaries(owner, [mine.id, nameOnly.id, theirs.id]);

      expect(summaries.get(mine.id)).toEqual({
        id: mine.id,
        name: "Capital One",
        date: "2026-10-01",
        amountCents: "45000",
      });
      expect(summaries.get(nameOnly.id)?.name).toBe("AMEX EPAYMENT");
      expect(summaries.has(theirs.id)).toBe(false);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
