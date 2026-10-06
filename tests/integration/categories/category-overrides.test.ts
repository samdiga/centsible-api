import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  billSetup,
  budgetItems,
  budgets,
  categories,
  categoryOverrides,
  forecastEvents,
  goals,
  rules,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createCategoryRepository } from "../../../src/modules/categories/categories.repository.js";
import { planAutoCategories } from "../../../src/modules/transactions/auto-categorize.js";
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

guardedDescribe("customising shared default categories", () => {
  it("gives one user a copy that takes over their data, leaving everyone else on the default", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const repository = createCategoryRepository(db);
      const me = randomUUID();
      const other = randomUUID();
      await db.insert(users).values([
        { id: me, email: `${me}@example.test` },
        { id: other, email: `${other}@example.test` },
      ]);
      const insertCategory = async (
        values: Partial<typeof categories.$inferInsert> & { name: string },
      ) => (await db.insert(categories).values(values).returning())[0]!;
      const food = await insertCategory({
        name: "Food & Drink",
        userId: null,
        color: "#f80",
      });
      const groceries = await insertCategory({
        name: "Groceries",
        userId: null,
        parentId: food.id,
      });
      const restaurants = await insertCategory({
        name: "Restaurants",
        userId: null,
        parentId: food.id,
      });
      const travel = await insertCategory({ name: "Travel", userId: null });
      const farmers = await insertCategory({
        name: "Farmers Market",
        userId: me,
        parentId: food.id,
      });

      const account = async (userId: string) =>
        (
          await db
            .insert(accounts)
            .values({
              userId,
              name: "Checking",
              type: "depository",
              subtype: "checking",
            })
            .returning()
        )[0]!;
      const mine = await account(me);
      const theirs = await account(other);
      const txn = async (
        userId: string,
        accountId: string,
        categoryId: string,
      ) =>
        (
          await db
            .insert(transactions)
            .values({
              userId,
              accountId,
              amount: 1000n,
              date: "2026-10-01",
              name: "SHOP",
              status: "posted",
              categoryId,
            })
            .returning()
        )[0]!;
      const myGroceries = await txn(me, mine.id, groceries.id);
      const myFood = await txn(me, mine.id, food.id);
      const theirGroceries = await txn(other, theirs.id, groceries.id);
      const [rule] = await db
        .insert(rules)
        .values({
          userId: me,
          matchType: "merchant_contains",
          matchMerchant: "shop",
          actionCategoryId: groceries.id,
        })
        .returning();
      const [bill] = await db
        .insert(billSetup)
        .values({
          userId: me,
          canonicalName: "csa box",
          cadence: "weekly",
          avgAmount: 3000n,
          categoryId: groceries.id,
        })
        .returning();
      const [budget] = await db
        .insert(budgets)
        .values({ userId: me, startDate: "2026-10-01" })
        .returning();
      const [item] = await db
        .insert(budgetItems)
        .values({
          budgetId: budget!.id,
          categoryId: groceries.id,
          amount: 50000n,
        })
        .returning();
      const [goal] = await db
        .insert(goals)
        .values({
          userId: me,
          name: "Eat out less",
          type: "savings",
          targetAmount: 10000n,
          linkedCategoryId: restaurants.id,
          autoContributeFromCategoryId: groceries.id,
        })
        .returning();
      const [event] = await db
        .insert(forecastEvents)
        .values({
          userId: me,
          name: "csa box",
          amount: 3000n,
          date: "2026-10-08",
          categoryId: groceries.id,
        })
        .returning();

      const copy = await db.transaction((tx) =>
        createCategoryRepository(db).customizeDefault(me, food.id, tx),
      );

      // The group and both default subcategories now have my copies.
      expect(copy).toMatchObject({
        userId: me,
        parentId: null,
        name: "Food & Drink",
        color: "#f80",
      });
      const overrides = await db
        .select()
        .from(categoryOverrides)
        .where(eq(categoryOverrides.userId, me));
      expect(overrides.map((row) => row.defaultCategoryId).sort()).toEqual(
        [food.id, groceries.id, restaurants.id].sort(),
      );
      const copyOf = new Map(
        overrides.map((row) => [row.defaultCategoryId, row.categoryId]),
      );
      const groceriesCopy = copyOf.get(groceries.id)!;
      const childCopies = await db
        .select()
        .from(categories)
        .where(
          inArray(categories.id, [groceriesCopy, copyOf.get(restaurants.id)!]),
        );
      expect(
        childCopies.every(
          (row) => row.userId === me && row.parentId === copy!.id,
        ),
      ).toBe(true);

      // My data follows the copies.
      const one = async <T>(rows: Promise<T[]>) => (await rows)[0]!;
      expect(
        (
          await one(
            db
              .select()
              .from(transactions)
              .where(eq(transactions.id, myGroceries.id)),
          )
        ).categoryId,
      ).toBe(groceriesCopy);
      expect(
        (
          await one(
            db
              .select()
              .from(transactions)
              .where(eq(transactions.id, myFood.id)),
          )
        ).categoryId,
      ).toBe(copy!.id);
      expect(
        (await one(db.select().from(rules).where(eq(rules.id, rule!.id))))
          .actionCategoryId,
      ).toBe(groceriesCopy);
      expect(
        (
          await one(
            db.select().from(billSetup).where(eq(billSetup.id, bill!.id)),
          )
        ).categoryId,
      ).toBe(groceriesCopy);
      expect(
        (
          await one(
            db.select().from(budgetItems).where(eq(budgetItems.id, item!.id)),
          )
        ).categoryId,
      ).toBe(groceriesCopy);
      expect(
        await one(db.select().from(goals).where(eq(goals.id, goal!.id))),
      ).toMatchObject({
        linkedCategoryId: copyOf.get(restaurants.id),
        autoContributeFromCategoryId: groceriesCopy,
      });
      expect(
        (
          await one(
            db
              .select()
              .from(forecastEvents)
              .where(eq(forecastEvents.id, event!.id)),
          )
        ).categoryId,
      ).toBe(groceriesCopy);
      expect(
        (
          await one(
            db.select().from(categories).where(eq(categories.id, farmers.id)),
          )
        ).parentId,
      ).toBe(copy!.id);

      // Everyone else, and the defaults themselves, are untouched.
      expect(
        (
          await one(
            db
              .select()
              .from(transactions)
              .where(eq(transactions.id, theirGroceries.id)),
          )
        ).categoryId,
      ).toBe(groceries.id);
      const defaults = await db
        .select()
        .from(categories)
        .where(
          inArray(categories.id, [
            food.id,
            groceries.id,
            restaurants.id,
            travel.id,
          ]),
        );
      expect(
        defaults.every((row) => row.userId === null && row.archivedAt === null),
      ).toBe(true);

      // I see my copies (and Travel, which I didn't change); they see the defaults.
      const names = async (userId: string) =>
        (await repository.listCategories(userId))
          .map(
            (row) => `${row.name}:${row.userId === null ? "default" : "mine"}`,
          )
          .sort();
      expect(await names(me)).toEqual(
        [
          "Farmers Market:mine",
          "Food & Drink:mine",
          "Groceries:mine",
          "Restaurants:mine",
          "Travel:default",
        ].sort(),
      );
      expect(await names(other)).toEqual(
        [
          "Food & Drink:default",
          "Groceries:default",
          "Restaurants:default",
          "Travel:default",
        ].sort(),
      );
      await expect(
        repository.getCategoryById(me, groceries.id),
      ).resolves.toBeNull();

      // New imports land on my copy; theirs on the default.
      const imported = (userId: string) =>
        planAutoCategories(
          userId,
          [
            {
              id: randomUUID(),
              merchantName: "Corner Market",
              name: "CORNER MARKET",
              plaidCategoryPrimary: "FOOD_AND_DRINK",
              plaidCategoryDetailed: "FOOD_AND_DRINK_GROCERIES",
            },
          ],
          db,
        );
      expect((await imported(me))[0]?.categoryId).toBe(groceriesCopy);
      expect((await imported(other))[0]?.categoryId).toBe(groceries.id);

      // Renaming my copy doesn't lose the bank's matches; archiving it does,
      // and they fall back to the parent group.
      await repository.updateCategory(me, groceriesCopy, {
        name: "Grocery runs",
      });
      expect((await imported(me))[0]?.categoryId).toBe(groceriesCopy);
      await repository.archiveCategory(me, groceriesCopy);
      expect((await imported(me))[0]?.categoryId).toBe(copy!.id);

      // Asking again returns the same copy and makes nothing new.
      const again = await db.transaction((tx) =>
        repository.customizeDefault(me, food.id, tx),
      );
      expect(again?.id).toBe(copy!.id);
      expect(
        (
          await db
            .select()
            .from(categoryOverrides)
            .where(eq(categoryOverrides.userId, me))
        ).length,
      ).toBe(3);
      await expect(
        db.transaction((tx) => repository.customizeDefault(me, farmers.id, tx)),
      ).resolves.toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("uses the user's own same-named category as the copy instead of a duplicate", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const repository = createCategoryRepository(db);
      const me = randomUUID();
      await db.insert(users).values({ id: me, email: `${me}@example.test` });
      const [travel] = await db
        .insert(categories)
        .values({ name: "Travel", userId: null })
        .returning();
      const [myTravel] = await db
        .insert(categories)
        .values({ name: "Travel", userId: me, archivedAt: new Date() })
        .returning();

      const copy = await db.transaction((tx) =>
        repository.customizeDefault(me, travel!.id, tx),
      );

      expect(copy).toMatchObject({ id: myTravel!.id, archivedAt: null });
      expect(
        await db
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.userId, me), eq(categories.name, "Travel"))),
      ).toHaveLength(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
