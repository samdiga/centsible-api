import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  budgetItems,
  budgets,
  categories,
  rules,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createUserMutationService } from "../../../src/platform/cache/user-revisions.repository.js";
import {
  ConflictError,
  ValidationError,
} from "../../../src/platform/errors/app-error.js";
import { createCategoryRepository } from "../../../src/modules/categories/categories.repository.js";
import { createCategoryService } from "../../../src/modules/categories/categories.service.js";
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

type TestDb = Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"];

const setUp = async (db: TestDb) => {
  const me = randomUUID();
  const other = randomUUID();
  await db.insert(users).values([
    { id: me, email: `${me}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  const category = async (
    values: Partial<typeof categories.$inferInsert> & { name: string },
  ) => (await db.insert(categories).values(values).returning())[0]!;
  const food = await category({ name: "Food & Drink", userId: null });
  const groceries = await category({
    name: "Groceries",
    userId: null,
    parentId: food.id,
  });
  const shopping = await category({ name: "Shopping", userId: null });
  const coffee = await category({
    name: "Coffee",
    userId: me,
    parentId: food.id,
  });
  const hobbies = await category({ name: "Hobbies", userId: me });
  const golf = await category({
    name: "Golf",
    userId: me,
    parentId: hobbies.id,
  });
  const [account] = await db
    .insert(accounts)
    .values({
      userId: me,
      name: "Checking",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  const [theirAccount] = await db
    .insert(accounts)
    .values({
      userId: other,
      name: "Checking",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  const spend = async (
    categoryId: string,
    userId = me,
    accountId = account!.id,
  ) =>
    (
      await db
        .insert(transactions)
        .values({
          userId,
          accountId,
          amount: 1500n,
          date: "2026-10-01",
          name: "SPEND",
          status: "posted",
          categoryId,
        })
        .returning()
    )[0]!;
  const [budget] = await db
    .insert(budgets)
    .values({ userId: me, startDate: "2026-10-01" })
    .returning();
  const plan = async (categoryId: string, amount: bigint) =>
    (
      await db
        .insert(budgetItems)
        .values({ budgetId: budget!.id, categoryId, amount })
        .returning()
    )[0]!;
  const mutation = createUserMutationService({
    db,
    cache: { invalidateUser: () => undefined },
    incrementRevision: async () => 1n,
    publishInvalidation: async () => undefined,
  });
  const service = createCategoryService({
    repository: createCategoryRepository(db),
    withUserMutation: mutation.withUserMutation,
    getUserRevision: async () => 1n,
  });
  return {
    me,
    other,
    food,
    groceries,
    shopping,
    coffee,
    hobbies,
    golf,
    spend,
    plan,
    budget: budget!,
    theirAccount: theirAccount!,
    service,
  };
};

const lookups = (db: TestDb) => ({
  categoryOf: async (transactionId: string) =>
    (
      await db
        .select({ categoryId: transactions.categoryId })
        .from(transactions)
        .where(eq(transactions.id, transactionId))
    )[0]!.categoryId,
  category: async (id: string) =>
    (await db.select().from(categories).where(eq(categories.id, id)))[0]!,
  ruleTarget: async (id: string) =>
    (
      await db
        .select({ categoryId: rules.actionCategoryId })
        .from(rules)
        .where(eq(rules.id, id))
    )[0]!.categoryId,
  planAmount: async (id: string) =>
    (
      await db
        .select({ amount: budgetItems.amount })
        .from(budgetItems)
        .where(eq(budgetItems.id, id))
    )[0]?.amount,
});

guardedDescribe("moving and deleting categories", () => {
  it("moves a subcategory to another group without touching its transactions", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const t = await setUp(db);
      const look = lookups(db);
      const latte = await t.spend(t.coffee.id);

      const moved = await t.service.updateCategory(t.me, t.coffee.id, {
        parentId: t.shopping.id,
      });
      expect(moved).toMatchObject({ id: t.coffee.id, parentId: t.shopping.id });
      expect(await look.categoryOf(latte.id)).toBe(t.coffee.id);

      // Moving a shared default moves my copy; the default stays put.
      const myGroceries = await t.service.updateCategory(t.me, t.groceries.id, {
        parentId: t.shopping.id,
      });
      expect(myGroceries).toMatchObject({
        parentId: t.shopping.id,
        isCustom: true,
      });
      expect(myGroceries.id).not.toBe(t.groceries.id);
      expect((await look.category(t.groceries.id)).parentId).toBe(t.food.id);

      // And back to a top-level group.
      await expect(
        t.service.updateCategory(t.me, t.coffee.id, { parentId: null }),
      ).resolves.toMatchObject({ parentId: null });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("keeps categories two levels deep", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const t = await setUp(db);
      const look = lookups(db);
      // Under a subcategory.
      await expect(
        t.service.updateCategory(t.me, t.coffee.id, { parentId: t.golf.id }),
      ).rejects.toBeInstanceOf(ValidationError);
      // A group that has subcategories.
      await expect(
        t.service.updateCategory(t.me, t.hobbies.id, {
          parentId: t.shopping.id,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      // To the top level when I already have a group by that name.
      await db.insert(categories).values({ name: "Coffee", userId: t.me });
      await expect(
        t.service.updateCategory(t.me, t.coffee.id, { parentId: null }),
      ).rejects.toBeInstanceOf(ConflictError);
      // Itself.
      await expect(
        t.service.updateCategory(t.me, t.hobbies.id, {
          parentId: t.hobbies.id,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await look.category(t.hobbies.id)).parentId).toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("deletes a subcategory into its parent, merging the plan and moving rules", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const t = await setUp(db);
      const look = lookups(db);
      const shop = await t.spend(t.groceries.id);
      const theirs = await t.spend(t.groceries.id, t.other, t.theirAccount.id);
      const groceriesPlan = await t.plan(t.groceries.id, 40000n);
      const foodPlan = await t.plan(t.food.id, 10000n);
      const [rule] = await db
        .insert(rules)
        .values({
          userId: t.me,
          matchType: "merchant_contains",
          matchMerchant: "market",
          actionCategoryId: t.groceries.id,
        })
        .returning();

      const result = await t.service.archiveCategory(t.me, t.groceries.id);

      expect(result).toEqual({ reassignedTo: t.food.id, movedTransactions: 1 });
      expect(await look.categoryOf(shop.id)).toBe(t.food.id);
      expect(await look.ruleTarget(rule!.id)).toBe(t.food.id);
      const plans = await db
        .select()
        .from(budgetItems)
        .where(eq(budgetItems.budgetId, t.budget.id));
      expect(
        plans.map((item) => [item.id, item.categoryId, item.amount]),
      ).toEqual([[foodPlan.id, t.food.id, 50000n]]);
      expect(
        plans.find((item) => item.id === groceriesPlan.id),
      ).toBeUndefined();
      // The default itself, and other users, are untouched.
      expect(await look.category(t.groceries.id)).toMatchObject({
        archivedAt: null,
        userId: null,
      });
      expect(await look.categoryOf(theirs.id)).toBe(t.groceries.id);
      // Gone for me.
      const mine = await t.service.listCategories(t.me);
      expect(mine.map((c) => c.name)).not.toContain("Groceries");
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("deletes a group: its subcategories become groups, and an explicit target or uncategorised takes the rest", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const t = await setUp(db);
      const look = lookups(db);
      const lesson = await t.spend(t.hobbies.id);
      await t.plan(t.hobbies.id, 20000n);
      const shoppingPlan = await t.plan(t.shopping.id, 5000n);

      await expect(
        t.service.archiveCategory(t.me, t.hobbies.id, {
          reassignTo: t.golf.id,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const toShopping = await t.service.archiveCategory(t.me, t.hobbies.id, {
        reassignTo: t.shopping.id,
      });
      expect(toShopping).toEqual({
        reassignedTo: t.shopping.id,
        movedTransactions: 1,
      });
      expect((await look.category(t.golf.id)).parentId).toBeNull();
      expect(await look.categoryOf(lesson.id)).toBe(t.shopping.id);
      expect(await look.planAmount(shoppingPlan.id)).toBe(25000n);

      const golfRound = await t.spend(t.golf.id);
      const golfPlan = await t.plan(t.golf.id, 3000n);
      await expect(
        t.service.archiveCategory(t.me, t.golf.id, {
          reassignTo: "uncategorized",
        }),
      ).resolves.toEqual({ reassignedTo: null, movedTransactions: 1 });
      expect(await look.categoryOf(golfRound.id)).toBeNull();
      expect(
        await db
          .select()
          .from(budgetItems)
          .where(eq(budgetItems.id, golfPlan.id)),
      ).toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("refuses to delete a group whose subcategory would clash with an existing group", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const t = await setUp(db);
      const look = lookups(db);
      await db.insert(categories).values({ name: "Golf", userId: t.me });
      await expect(
        t.service.archiveCategory(t.me, t.hobbies.id),
      ).rejects.toBeInstanceOf(ConflictError);
      // Nothing changed: the transaction rolled back.
      expect(await look.category(t.hobbies.id)).toMatchObject({
        archivedAt: null,
      });
      expect((await look.category(t.golf.id)).parentId).toBe(t.hobbies.id);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
