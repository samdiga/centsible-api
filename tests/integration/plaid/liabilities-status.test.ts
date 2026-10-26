import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

guardedDescribe("Liabilities status per connection", () => {
  it("asks only connections with a live card or loan, and records what the bank said", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const me = randomUUID();
      const someoneElse = randomUUID();
      await db.insert(users).values([
        { id: me, email: `${me}@example.test` },
        { id: someoneElse, email: `${someoneElse}@example.test` },
      ]);
      const item = (userId: string, name: string) => ({
        userId,
        plaidItemId: `plaid-${randomUUID()}`,
        institutionId: "ins_test",
        institutionName: name,
        accessTokenEncrypted: "encrypted",
        accessTokenNonce: "nonce",
      });
      const [cards, checking, removedCard, theirs] = await db
        .insert(plaidItems)
        .values([
          item(me, "Card bank"),
          item(me, "Checking bank"),
          item(me, "Removed card bank"),
          item(someoneElse, "Their card bank"),
        ])
        .returning();
      await db.insert(accounts).values([
        {
          userId: me,
          plaidItemId: cards!.id,
          name: "Card",
          type: "credit",
          subtype: "credit_card",
        },
        {
          userId: me,
          plaidItemId: checking!.id,
          name: "Checking",
          type: "depository",
          subtype: "checking",
        },
        {
          userId: me,
          plaidItemId: removedCard!.id,
          name: "Old card",
          type: "credit",
          subtype: "credit_card",
          deletedAt: new Date(),
        },
        {
          userId: someoneElse,
          plaidItemId: theirs!.id,
          name: "Their card",
          type: "credit",
          subtype: "credit_card",
        },
      ]);
      const repository = createPlaidItemsRepository(testDb.db);

      expect(await repository.hasLiabilityAccounts(cards!.id, me)).toBe(true);
      expect(await repository.hasLiabilityAccounts(checking!.id, me)).toBe(
        false,
      );
      expect(await repository.hasLiabilityAccounts(removedCard!.id, me)).toBe(
        false,
      );
      // Another user's connection is never theirs to check.
      expect(await repository.hasLiabilityAccounts(theirs!.id, me)).toBe(false);

      await repository.setLiabilitiesStatus(cards!.id, me, "consent_required");
      await repository.setLiabilitiesStatus(theirs!.id, me, "not_supported");
      const status = async (id: string) =>
        (
          await db
            .select({ status: plaidItems.liabilitiesStatus })
            .from(plaidItems)
            .where(eq(plaidItems.id, id))
        )[0]?.status;
      expect(await status(cards!.id)).toBe("consent_required");
      expect(await status(theirs!.id)).toBeNull();

      await repository.setLiabilitiesStatus(cards!.id, me, "available");
      expect(await status(cards!.id)).toBe("available");

      await expect(
        db
          .update(plaidItems)
          .set({ liabilitiesStatus: "maybe" as never })
          .where(eq(plaidItems.id, cards!.id)),
      ).rejects.toThrow();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
