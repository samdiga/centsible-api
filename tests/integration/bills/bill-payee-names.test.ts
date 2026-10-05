import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  plaidItems,
  transactions,
  users,
} from "../../../database/schema/index.js";
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

guardedDescribe("bill payee names for transfer bills", () => {
  it("returns an account's names and bank, only for the user's own accounts", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const repository = createBillsRepository(db);
      const me = randomUUID();
      const other = randomUUID();
      await db.insert(users).values([
        { id: me, email: `${me}@example.test`, name: "U" },
        { id: other, email: `${other}@example.test`, name: "O" },
      ]);
      const [item] = await db
        .insert(plaidItems)
        .values({
          userId: me,
          plaidItemId: `item-${randomUUID()}`,
          institutionId: "ins_test",
          institutionName: "Chase",
          accessTokenEncrypted: "x",
          accessTokenNonce: "x",
        })
        .returning();
      const [card, manualLoan, theirs] = await db
        .insert(accounts)
        .values([
          {
            userId: me,
            plaidItemId: item!.id,
            name: "Sapphire Preferred",
            nameOverride: "Travel card",
            officialName: "Chase Sapphire Preferred Visa",
            type: "credit",
            subtype: "credit_card",
            currency: "USD",
          },
          {
            userId: me,
            name: "Volvo loan",
            type: "loan",
            subtype: "auto",
            currency: "USD",
            isManual: true,
          },
          {
            userId: other,
            name: "Their card",
            type: "credit",
            subtype: "credit_card",
            currency: "USD",
            isManual: true,
          },
        ])
        .returning();

      const names = await repository.listAccountPayeeNames(me, [
        card!.id,
        manualLoan!.id,
        theirs!.id,
      ]);
      expect(names.get(card!.id)).toEqual([
        "Sapphire Preferred",
        "Travel card",
        "Chase Sapphire Preferred Visa",
        "Chase",
      ]);
      expect(names.get(manualLoan!.id)).toEqual(["Volvo loan"]);
      expect(names.has(theirs!.id)).toBe(false);
      expect((await repository.listAccountPayeeNames(me, [])).size).toBe(0);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("lists posted payments received on the user's accounts in the date range, as positive amounts", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const repository = createBillsRepository(db);
      const me = randomUUID();
      const other = randomUUID();
      await db.insert(users).values([
        { id: me, email: `${me}@example.test`, name: "U" },
        { id: other, email: `${other}@example.test`, name: "O" },
      ]);
      const [card, checking, theirs] = await db
        .insert(accounts)
        .values([
          {
            userId: me,
            name: "Platinum",
            type: "credit",
            subtype: "credit_card",
            currency: "USD",
            isManual: true,
          },
          {
            userId: me,
            name: "Checking",
            type: "depository",
            subtype: "checking",
            currency: "USD",
            isManual: true,
          },
          {
            userId: other,
            name: "Their card",
            type: "credit",
            subtype: "credit_card",
            currency: "USD",
            isManual: true,
          },
        ])
        .returning();
      const txn = (
        userId: string,
        accountId: string,
        amount: bigint,
        date: string,
        extra: Partial<typeof transactions.$inferInsert> = {},
      ) => ({
        userId,
        accountId,
        amount,
        date,
        currency: "USD",
        name: "PAYMENT THANK YOU",
        status: "posted" as const,
        ...extra,
      });
      await db.insert(transactions).values([
        txn(me, card!.id, -110758n, "2026-10-01"),
        txn(me, card!.id, 4500n, "2026-10-01"), // a purchase, not a payment
        txn(me, card!.id, -2131n, "2026-09-20"), // before the range
        txn(me, card!.id, -999n, "2026-10-02", { status: "pending" }),
        txn(me, card!.id, -888n, "2026-10-02", { deletedAt: new Date() }),
        txn(me, checking!.id, -5000n, "2026-10-01"), // not asked for
        txn(other, theirs!.id, -110758n, "2026-10-01"),
      ]);

      const inflows = await repository.listAccountInflows(
        me,
        [card!.id, theirs!.id],
        "2026-09-25",
        "2026-10-05",
      );
      expect(inflows).toEqual([
        { accountId: card!.id, date: "2026-10-01", amount: 110758n },
      ]);
      expect(
        await repository.listAccountInflows(me, [], "2026-09-25", "2026-10-05"),
      ).toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
