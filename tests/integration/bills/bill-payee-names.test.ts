import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accounts, plaidItems, users } from "../../../database/schema/index.js";
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
});
