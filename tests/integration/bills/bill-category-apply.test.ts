import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
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

guardedDescribe("bill category on a matched payment", () => {
  it("replaces rule/auto categories and fills empty ones, never a hand-picked, deleted or other user's", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const repository = createBillsRepository(db);
      const makeUser = async () => {
        const id = randomUUID();
        await db
          .insert(users)
          .values({ id, email: `${id}@example.test`, name: "U" });
        const [account] = await db
          .insert(accounts)
          .values({
            userId: id,
            name: "Checking",
            type: "depository",
            subtype: "checking",
            currency: "USD",
            isManual: true,
          })
          .returning();
        return { id, accountId: account!.id };
      };
      const me = await makeUser();
      const other = await makeUser();
      const [ruleCategory] = await db
        .insert(categories)
        .values({ name: "Shopping", userId: me.id })
        .returning();
      const [billCategory] = await db
        .insert(categories)
        .values({ name: "Utilities", userId: me.id })
        .returning();
      const txn = async (
        owner: { id: string; accountId: string },
        fields: Partial<typeof transactions.$inferInsert>,
      ) =>
        (
          await db
            .insert(transactions)
            .values({
              userId: owner.id,
              accountId: owner.accountId,
              amount: 8000n,
              currency: "USD",
              date: "2026-09-20",
              name: "City Power",
              status: "posted",
              ...fields,
            })
            .returning()
        )[0]!;

      const byRule = await txn(me, { categoryId: ruleCategory!.id });
      const empty = await txn(me, {});
      const handPicked = await txn(me, {
        categoryId: ruleCategory!.id,
        userCategoryOverride: true,
      });
      const deleted = await txn(me, { deletedAt: new Date() });
      const theirs = await txn(other, {});

      const apply = (id: string, userId = me.id) =>
        repository.applyBillCategoryToTransaction(userId, id, billCategory!.id);
      expect(await apply(byRule.id)).toBe(true);
      expect(await apply(empty.id)).toBe(true);
      expect(await apply(handPicked.id)).toBe(false);
      expect(await apply(deleted.id)).toBe(false);
      expect(await apply(theirs.id)).toBe(false);
      // Already the bill's category: nothing to change.
      expect(await apply(byRule.id)).toBe(false);

      const row = async (id: string) =>
        (
          await db.select().from(transactions).where(eq(transactions.id, id))
        )[0]!;
      expect((await row(byRule.id)).categoryId).toBe(billCategory!.id);
      expect((await row(byRule.id)).userCategoryOverride).toBe(false);
      expect((await row(empty.id)).categoryId).toBe(billCategory!.id);
      expect((await row(handPicked.id)).categoryId).toBe(ruleCategory!.id);
      expect((await row(deleted.id)).categoryId).toBeNull();
      expect((await row(theirs.id)).categoryId).toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
