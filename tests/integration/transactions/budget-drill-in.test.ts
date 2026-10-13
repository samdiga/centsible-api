import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  budgetItems,
  budgets,
  categories,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createBudgetRepository } from "../../../src/modules/budgets/budgets.repository.js";
import { createBudgetsService } from "../../../src/modules/budgets/budgets.service.js";
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

guardedDescribe("budget drill-in", () => {
  it("lists exactly the transactions behind each Budget usage row", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [food] = await db
        .insert(categories)
        .values({ userId, name: "Food" })
        .returning();
      const [dining, travel, transfer, excluded] = await db
        .insert(categories)
        .values([
          { userId, name: "Dining", parentId: food!.id },
          { userId, name: "Travel" },
          { userId, name: "Transfer", isTransfer: true },
          { userId, name: "Reimbursable", excludeFromBudgets: true },
        ])
        .returning();
      const [checking, removed] = await db
        .insert(accounts)
        .values([
          { userId, name: "Checking", type: "depository", subtype: "checking" },
          {
            userId,
            name: "Gone",
            type: "depository",
            subtype: "checking",
            deletedAt: new Date(),
          },
        ])
        .returning();
      const [budget] = await db
        .insert(budgets)
        .values({ userId, startDate: "2026-09-01" })
        .returning();
      await db
        .insert(budgetItems)
        .values({
          budgetId: budget!.id,
          categoryId: dining!.id,
          amount: 20000n,
        });

      const txn = (
        name: string,
        amount: bigint,
        options: Partial<typeof transactions.$inferInsert> = {},
      ) => ({
        userId,
        accountId: checking!.id,
        name,
        amount,
        date: "2026-10-15",
        status: "posted" as const,
        categoryId: dining!.id,
        ...options,
      });
      await db
        .insert(transactions)
        .values([
          txn("dinner", 10000n),
          txn("pending lunch", 3000n, { status: "pending" }),
          txn("refund", -2500n),
          txn("hidden snack", 400n, { reviewStatus: "hidden" }),
          txn("groceries", 5000n, { categoryId: food!.id }),
          txn("flight", 30000n, { categoryId: travel!.id }),
          txn("to savings", 9999n, { categoryId: transfer!.id }),
          txn("work lunch", 1111n, { categoryId: excluded!.id }),
          txn("left out", 7777n, { excludeFromBudgets: true }),
          txn("card payment", 20000n, {
            categoryId: null,
            plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
          }),
          txn("mystery", 1200n, { categoryId: null }),
          txn("paycheck", -250000n, {
            categoryId: null,
            plaidCategoryPrimary: "INCOME",
          }),
          txn("next month", 6666n, { date: "2026-11-01" }),
          txn("removed account", 8888n, { accountId: removed!.id }),
        ]);

      const usage = await createBudgetsService({
        repository: createBudgetRepository(db),
        cache: {
          getOrCompute: async <T>(_key: unknown, compute: () => Promise<T>) =>
            compute(),
          invalidateUser: vi.fn(),
        } as never,
        getUserRevision: async () => 1n,
      }).getActiveBudgetUsage(userId, {
        month: "2026-10",
        accountIds: [],
        categoryIds: [],
        tagIds: [],
      });

      const repository = createTransactionRepository(db);
      const list = async (
        filters: Parameters<typeof repository.listByUser>[0]["filters"],
      ) =>
        (
          await repository.listByUser({
            userId,
            limit: 200,
            cursor: undefined,
            filters: {
              dateFrom: "2026-10-01",
              dateTo: "2026-10-31",
              budget: true,
              ...filters,
            },
          })
        ).rows;
      const sum = (rows: Array<{ amount: bigint }>) =>
        rows.reduce((total, row) => total + row.amount, 0n);
      const spent = (categoryId: string) =>
        BigInt(
          usage.categories.find((row) => row.categoryId === categoryId)
            ?.spentCents ?? "0",
        );

      // Every row of usage adds up to its drill-in, and nothing is left over.
      for (const row of usage.categories) {
        const rows = await list({ categoryIds: [row.categoryId] });
        expect(sum(rows), row.categoryId).toBe(BigInt(row.spentCents));
      }
      const uncategorized = await list({ uncategorized: true });
      expect(sum(uncategorized)).toBe(BigInt(usage.uncategorizedSpentCents));
      expect(uncategorized.map((row) => row.name)).toEqual(["mystery"]);

      const diningRows = await list({ categoryIds: [dining!.id] });
      expect(diningRows.map((row) => row.name).sort()).toEqual([
        "dinner",
        "hidden snack",
        "pending lunch",
        "refund",
      ]);
      // A main category alone: only what's filed directly under it.
      expect(
        (await list({ categoryIds: [food!.id] })).map((row) => row.name),
      ).toEqual(["groceries"]);
      // With its subcategories: the group's roll-up.
      expect(
        sum(await list({ categoryIds: [food!.id], includeChildren: true })),
      ).toBe(spent(food!.id) + spent(dining!.id));
      // Excluded by the budget rules: never listed.
      const everything = await list({});
      for (const name of [
        "to savings",
        "work lunch",
        "left out",
        "card payment",
        "paycheck",
        "next month",
        "removed account",
      ])
        expect(everything.map((row) => row.name)).not.toContain(name);

      // Activity (no budget filter) still hides hidden transactions.
      const activity = await repository.listByUser({
        userId,
        limit: 200,
        cursor: undefined,
        filters: {
          dateFrom: "2026-10-01",
          dateTo: "2026-10-31",
          categoryIds: [dining!.id],
        },
      });
      expect(activity.rows.map((row) => row.name)).not.toContain(
        "hidden snack",
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
