import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  budgetItems,
  budgets,
  categories,
  users,
} from "../../../database/schema/index.js";
import {
  createBudgetRepository,
  type BudgetRow,
} from "../../../src/modules/budgets/budgets.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

const guardedDescribe = hasExternalTestDatabaseApproval()
  ? describe
  : describe.skip;

guardedDescribe("isolated budget repository", () => {
  it("replaces all items in one transaction and preserves the active budget", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userId = randomUUID();
    const firstCategoryId = randomUUID();
    const secondCategoryId = randomUUID();
    try {
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "Budget Test User",
      });
      await testDb.db.insert(categories).values([
        { id: firstCategoryId, userId, name: "Food" },
        { id: secondCategoryId, userId, name: "Travel" },
      ]);
      const repository = createBudgetRepository(testDb.db);
      const budget: BudgetRow = await repository.createBudget(userId, {
        items: [{ categoryId: firstCategoryId, amountCents: 10_000n }],
      });

      await repository.replaceBudgetItems(budget.id, [
        { categoryId: secondCategoryId, amountCents: 20_000n },
      ]);

      const active = await repository.getActiveBudget(userId);
      const items = await repository.getBudgetItems(budget.id);
      expect(active?.id).toBe(budget.id);
      expect(items).toHaveLength(1);
      expect(items[0]?.categoryId).toBe(secondCategoryId);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("keeps budget rows tenant-scoped through the active lookup", async () => {
    const testDb = await createIsolatedTestDatabase();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    try {
      await testDb.db.insert(users).values([
        { id: ownerId, email: `${ownerId}@example.test`, name: "Owner" },
        { id: otherId, email: `${otherId}@example.test`, name: "Other" },
      ]);
      const repository = createBudgetRepository(testDb.db);
      await repository.createBudget(ownerId, { items: [] });
      expect(await repository.getActiveBudget(otherId)).toBeNull();
      const rows = await testDb.db
        .select({ id: budgets.id })
        .from(budgets)
        .where(and(eq(budgets.userId, ownerId), eq(budgets.isActive, true)));
      expect(rows).toHaveLength(1);
      expect(await testDb.db.select().from(budgetItems)).toHaveLength(0);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
