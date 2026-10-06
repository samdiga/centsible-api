import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  billSetup,
  transactions,
  users,
} from "../../../database/schema/index.js";
import {
  dueDateAfter,
  lastStatementDate,
  withDerivedStatements,
} from "../../../src/modules/accounts/card-statement.js";
import { createAccountRepository } from "../../../src/modules/accounts/accounts.repository.js";
import { upsertStatementBills } from "../../../src/modules/bills/statement-bills.js";
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

guardedDescribe(
  "card statements from the user's statement and due days",
  () => {
    it("works the statement out from the balance and what posted since the close", async () => {
      const testDb = await createIsolatedTestDatabase();
      try {
        const { db } = testDb;
        const me = randomUUID();
        await db.insert(users).values({ id: me, email: `${me}@example.test` });
        const [card, , checking] = await db
          .insert(accounts)
          .values([
            {
              userId: me,
              name: "Venture",
              type: "credit",
              subtype: "credit_card",
              currentBalance: 125000n,
              statementDay: 3,
              paymentDueDay: 28,
            },
            // The bank reports a statement: it wins over the user's days.
            {
              userId: me,
              name: "Platinum",
              type: "credit",
              subtype: "credit_card",
              currentBalance: 9000n,
              statementBalance: 7000n,
              statementDate: "2026-09-25",
              paymentDueDate: "2026-10-20",
              statementDay: 3,
              paymentDueDay: 28,
            },
            {
              userId: me,
              name: "Checking",
              type: "depository",
              subtype: "checking",
              currentBalance: 50000n,
            },
          ])
          .returning();
        const txn = (
          accountId: string,
          date: string,
          amount: bigint,
          extra: Partial<typeof transactions.$inferInsert> = {},
        ) => ({
          userId: me,
          accountId,
          date,
          amount,
          name: "SPEND",
          status: "posted" as const,
          ...extra,
        });
        await db.insert(transactions).values([
          txn(card!.id, "2026-10-02", 9999n), // before the close: part of the statement
          txn(card!.id, "2026-10-04", 30000n), // charge after the close
          txn(card!.id, "2026-10-05", -50000n), // payment after the close
          txn(card!.id, "2026-10-05", 1111n, { status: "pending" }),
          txn(card!.id, "2026-10-05", 2222n, { deletedAt: new Date() }),
          txn(card!.id, "2026-10-07", 3333n), // after "today"
          txn(checking!.id, "2026-10-05", 50000n),
        ]);
        const rows = await db
          .select()
          .from(accounts)
          .where(eq(accounts.userId, me));

        const derived = await withDerivedStatements(db, me, rows, "2026-10-06");
        const byName = new Map(derived.map((row) => [row.name, row]));

        // Owed $1,250 now; since the 3rd: +$300 charges, -$500 payment.
        expect(byName.get("Venture")).toMatchObject({
          statementDerived: true,
          statementDate: "2026-10-03",
          paymentDueDate: "2026-10-28",
          statementBalance: 145000n,
        });
        expect(byName.get("Platinum")).toMatchObject({
          statementDerived: false,
          statementDate: "2026-09-25",
          paymentDueDate: "2026-10-20",
          statementBalance: 7000n,
        });
        expect(byName.get("Checking")).toMatchObject({
          statementDerived: false,
          statementBalance: null,
        });

        // The account repository exposes the same thing to the API.
        const listed = await createAccountRepository(db).withDerivedStatements!(
          me,
          await createAccountRepository(db).listByUser(me),
          "2026-10-06",
        );
        expect(
          listed.find((row) => row.name === "Venture")?.statementBalance,
        ).toBe(145000n);
      } finally {
        await testDb.cleanup();
      }
    }, 120_000);

    it("gives a Transactions-only card its monthly statement bill", async () => {
      const testDb = await createIsolatedTestDatabase();
      try {
        const { db } = testDb;
        const me = randomUUID();
        await db.insert(users).values({ id: me, email: `${me}@example.test` });
        // Statement day = today, so nothing has posted since the close.
        const today = new Date().toISOString().slice(0, 10);
        const day = Number(today.slice(8));
        await db.insert(accounts).values({
          userId: me,
          name: "Venture",
          type: "credit",
          subtype: "credit_card",
          currentBalance: 64321n,
          statementDay: day,
          paymentDueDay: day,
        });
        const mutation = createUserMutationService({
          db,
          cache: { invalidateUser: () => undefined },
          incrementRevision: async () => 1n,
          publishInvalidation: async () => undefined,
        });

        await expect(
          upsertStatementBills(me, {
            db,
            withUserMutation: mutation.withUserMutation,
          }),
        ).resolves.toEqual({ created: 1, updated: 0 });

        const [bill] = await db
          .select()
          .from(billSetup)
          .where(eq(billSetup.userId, me));
        expect(bill).toMatchObject({
          canonicalName: "Venture payment",
          billType: "transfer",
          avgAmount: 64321n,
          nextExpectedDate: dueDateAfter(lastStatementDate(day, today), day),
        });
      } finally {
        await testDb.cleanup();
      }
    }, 120_000);
  },
);
