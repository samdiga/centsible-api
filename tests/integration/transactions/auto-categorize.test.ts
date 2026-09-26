import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  plaidItems,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { autoCategorize } from "../../../src/modules/transactions/auto-categorize.js";
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

guardedDescribe("auto-categorize", () => {
  it("prefers the user's past choice for the merchant, then the bank category, else nothing", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const [food] = await db
        .insert(categories)
        .values({ name: "Food & Drink" })
        .returning();
      const [groceries] = await db
        .insert(categories)
        .values({ name: "Groceries", parentId: food!.id })
        .returning();
      const [travel] = await db
        .insert(categories)
        .values({ name: "Travel" })
        .returning();
      const [mine] = await db
        .insert(categories)
        .values({ name: "Treats", userId })
        .returning();
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
          plaidAccountId: "pa",
          name: "Card",
          type: "credit",
          subtype: "credit_card",
          currency: "USD",
        })
        .returning();
      const txn = async (fields: Partial<typeof transactions.$inferInsert>) =>
        (
          await db
            .insert(transactions)
            .values({
              userId,
              accountId: account!.id,
              amount: 500n,
              currency: "USD",
              date: "2026-09-25",
              name: "x",
              status: "posted",
              ...fields,
            })
            .returning()
        )[0]!;
      // The user once filed Whole Foods under their own "Treats".
      await txn({
        merchantName: "Whole Foods",
        categoryId: mine!.id,
        userCategoryOverride: true,
        date: "2026-09-01",
      });
      const history = await txn({
        merchantName: "whole foods ",
        plaidCategoryPrimary: "FOOD_AND_DRINK",
        plaidCategoryDetailed: "FOOD_AND_DRINK_GROCERIES",
      });
      const bank = await txn({
        merchantName: "Trader Joe's",
        plaidCategoryPrimary: "FOOD_AND_DRINK",
        plaidCategoryDetailed: "FOOD_AND_DRINK_GROCERIES",
      });
      const group = await txn({
        merchantName: "Delta",
        plaidCategoryPrimary: "TRAVEL",
        plaidCategoryDetailed: "TRAVEL_OTHER_TRAVEL",
      });
      const none = await txn({
        merchantName: "Insurer",
        plaidCategoryPrimary: "GENERAL_SERVICES",
        plaidCategoryDetailed: "GENERAL_SERVICES_INSURANCE",
      });

      const result = await autoCategorize(
        userId,
        [history, bank, group, none].map((row) => ({
          id: row.id,
          merchantName: row.merchantName,
          name: row.name,
          plaidCategoryPrimary: row.plaidCategoryPrimary,
          plaidCategoryDetailed: row.plaidCategoryDetailed,
        })),
        db,
      );

      const categoryOf = async (id: string) =>
        (
          await db.select().from(transactions).where(eq(transactions.id, id))
        )[0]!;
      expect(result).toEqual({ fromHistory: 1, fromBank: 2 });
      expect((await categoryOf(history.id)).categoryId).toBe(mine!.id);
      expect((await categoryOf(bank.id)).categoryId).toBe(groceries!.id);
      expect((await categoryOf(group.id)).categoryId).toBe(travel!.id);
      expect((await categoryOf(none.id)).categoryId).toBeNull();
      expect((await categoryOf(bank.id)).userCategoryOverride).toBe(false);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
