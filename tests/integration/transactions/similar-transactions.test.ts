import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  plaidItems,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
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

guardedDescribe("similar transactions by merchant", () => {
  it("returns same-merchant rows in a different category, tenant-scoped, excluding the edited, deleted and removed-account rows", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const repository = createTransactionRepository(db);
      const makeUser = async () => {
        const id = randomUUID();
        await db
          .insert(users)
          .values({ id, email: `${id}@example.test`, name: "U" });
        const [item] = await db
          .insert(plaidItems)
          .values({
            userId: id,
            plaidItemId: `pi-${randomUUID()}`,
            institutionId: "ins",
            institutionName: "Bank",
            accessTokenEncrypted: "e",
            accessTokenNonce: "n",
          })
          .returning();
        const account = async (deletedAt: Date | null = null) =>
          (
            await db
              .insert(accounts)
              .values({
                userId: id,
                plaidItemId: item!.id,
                plaidAccountId: `pa-${randomUUID()}`,
                name: "Card",
                type: "credit",
                subtype: "credit_card",
                currency: "USD",
                deletedAt,
              })
              .returning()
          )[0]!;
        return {
          id,
          live: await account(),
          removed: await account(new Date()),
        };
      };
      const me = await makeUser();
      const other = await makeUser();
      const [coffee] = await db
        .insert(categories)
        .values({ name: "Coffee" })
        .returning();
      const [dining] = await db
        .insert(categories)
        .values({ name: "Dining" })
        .returning();
      const txn = async (
        userId: string,
        accountId: string,
        fields: Partial<typeof transactions.$inferInsert>,
      ) =>
        (
          await db
            .insert(transactions)
            .values({
              userId,
              accountId,
              amount: 500n,
              currency: "USD",
              date: "2026-09-20",
              name: "x",
              status: "posted",
              ...fields,
            })
            .returning()
        )[0]!;

      const edited = await txn(me.id, me.live.id, {
        merchantName: "Blue Bottle",
        name: "BLUE BOTTLE #12",
        categoryId: coffee!.id,
      });
      const uncategorised = await txn(me.id, me.live.id, {
        merchantName: "  blue bottle ",
        name: "BLUE BOTTLE #7",
        date: "2026-09-18",
      });
      const otherCategory = await txn(me.id, me.live.id, {
        merchantName: "Blue Bottle",
        name: "BB",
        categoryId: dining!.id,
        date: "2026-09-19",
      });
      // Falls back to the name when the merchant is missing.
      const byName = await txn(me.id, me.live.id, {
        merchantName: null,
        name: "Blue Bottle",
        date: "2026-09-10",
      });
      await txn(me.id, me.live.id, {
        merchantName: "Blue Bottle",
        categoryId: coffee!.id,
      }); // already in the new category
      await txn(me.id, me.live.id, {
        merchantName: "Blue Bottle",
        deletedAt: new Date(),
      }); // deleted
      await txn(me.id, me.removed.id, { merchantName: "Blue Bottle" }); // removed account
      await txn(me.id, me.live.id, { merchantName: "Philz" }); // other merchant
      await txn(other.id, other.live.id, { merchantName: "Blue Bottle" }); // other tenant

      const rows = await repository.listSimilarByMerchant({
        userId: me.id,
        transactionId: edited.id,
        limit: 100,
      });
      expect(rows?.map((row) => row.id)).toEqual([
        otherCategory.id,
        uncategorised.id,
        byName.id,
      ]);

      const bounded = await repository.listSimilarByMerchant({
        userId: me.id,
        transactionId: edited.id,
        limit: 1,
      });
      expect(bounded?.map((row) => row.id)).toEqual([otherCategory.id]);

      // An uncategorised edited transaction matches rows that do have one.
      const fromUncategorised = await repository.listSimilarByMerchant({
        userId: me.id,
        transactionId: uncategorised.id,
        limit: 100,
      });
      expect(fromUncategorised?.map((row) => row.id)).toEqual(
        expect.arrayContaining([edited.id, otherCategory.id]),
      );
      expect(fromUncategorised?.map((row) => row.id)).not.toContain(byName.id);

      expect(
        await repository.listSimilarByMerchant({
          userId: other.id,
          transactionId: edited.id,
          limit: 100,
        }),
      ).toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
