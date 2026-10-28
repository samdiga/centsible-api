import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  plaidItems,
  users,
} from "../../../database/schema/index.js";
import { createPlaidItemsRepository } from "../../../src/modules/plaid/plaid-items.repository.js";
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

guardedDescribe("spotting a bank account linked again", () => {
  it("matches a live account on a live connection to the same bank by mask, type and subtype", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const me = randomUUID();
      const someoneElse = randomUUID();
      await db.insert(users).values([
        { id: me, email: `${me}@example.test` },
        { id: someoneElse, email: `${someoneElse}@example.test` },
      ]);
      const item = (
        userId: string,
        institutionId: string,
        deletedAt: Date | null = null,
      ) => ({
        userId,
        plaidItemId: `plaid-${randomUUID()}`,
        institutionId,
        institutionName: "Macy's - Citi Card",
        accessTokenEncrypted: "encrypted",
        accessTokenNonce: "nonce",
        deletedAt,
      });
      const [macys, otherBank, removedItem, theirs] = await db
        .insert(plaidItems)
        .values([
          item(me, "ins_citi"),
          item(me, "ins_other"),
          item(me, "ins_citi", new Date()),
          item(someoneElse, "ins_citi"),
        ])
        .returning();
      const card = (
        userId: string,
        plaidItemId: string,
        mask: string,
        extra: Partial<typeof accounts.$inferInsert> = {},
      ) => ({
        userId,
        plaidItemId,
        name: "Macy's American Express® Card",
        type: "credit" as const,
        subtype: "credit_card" as const,
        mask,
        ...extra,
      });
      const [nicknamed] = await db
        .insert(accounts)
        .values([
          // The user renamed it; the match must not depend on the name.
          card(me, macys!.id, "6051", { nameOverride: "Macy's AMEX" }),
          card(me, macys!.id, "7777", { deletedAt: new Date() }),
          card(me, otherBank!.id, "8888"),
          card(me, removedItem!.id, "9999"),
          card(someoneElse, theirs!.id, "5555"),
          card(me, macys!.id, "4444", {
            type: "depository",
            subtype: "checking",
          }),
        ])
        .returning();
      const repository = createPlaidItemsRepository(db);
      const find = (mask: string, type = "credit", subtype = "credit_card") =>
        repository.findLiveAccountMatches(me, "ins_citi", [
          { mask, type: type as never, subtype: subtype as never },
        ]);

      await expect(find("6051")).resolves.toEqual([
        {
          itemId: macys!.id,
          institutionName: "Macy's - Citi Card",
          accountId: nicknamed!.id,
          name: "Macy's AMEX",
          mask: "6051",
        },
      ]);
      // Different mask, a removed account, another bank, a removed
      // connection, another user, or a different account type: no match.
      for (const mask of ["1234", "7777", "8888", "9999", "5555"])
        await expect(find(mask)).resolves.toEqual([]);
      await expect(find("4444")).resolves.toEqual([]);
      await expect(
        repository.findLiveAccountMatches(me, "ins_citi", []),
      ).resolves.toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
