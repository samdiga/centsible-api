import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  budgetItems,
  budgets,
  categories,
  tags,
  transactionTags,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createBudgetRepository } from "../../../src/modules/budgets/budgets.repository.js";
import { createBudgetsService } from "../../../src/modules/budgets/budgets.service.js";
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

guardedDescribe("budget usage", () => {
  it("applies the spend rules, month bounds, plan rules and filters", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherId = randomUUID();
      await testDb.db
        .insert(users)
        .values(
          [userId, otherId].map((id) => ({ id, email: `${id}@example.test` })),
        );
      const [food] = await testDb.db
        .insert(categories)
        .values({ userId, name: "Food" })
        .returning();
      const [dining, gym, travel, transfer, income, excluded] = await testDb.db
        .insert(categories)
        .values([
          { userId, name: "Dining", parentId: food!.id },
          { userId, name: "Gym" },
          { userId, name: "Travel" },
          { userId, name: "Transfer", isTransfer: true },
          { userId, name: "Paycheck", isIncome: true },
          { userId, name: "Reimbursable", excludeFromBudgets: true },
        ])
        .returning();
      const [checking, card, removed, othersAccount] = await testDb.db
        .insert(accounts)
        .values([
          { userId, name: "Checking", type: "depository", subtype: "checking" },
          { userId, name: "Card", type: "credit", subtype: "credit_card" },
          {
            userId,
            name: "Removed",
            type: "depository",
            subtype: "checking",
            deletedAt: new Date(),
          },
          {
            userId: otherId,
            name: "Theirs",
            type: "depository",
            subtype: "checking",
          },
        ])
        .returning();
      const [budget] = await testDb.db
        .insert(budgets)
        .values({ userId, startDate: "2026-09-01" })
        .returning();
      await testDb.db.insert(budgetItems).values([
        { budgetId: budget!.id, categoryId: food!.id, amount: 50000n },
        { budgetId: budget!.id, categoryId: dining!.id, amount: 20000n },
        {
          budgetId: budget!.id,
          categoryId: gym!.id,
          amount: 4000n,
          isPaused: true,
        },
      ]);
      const [tag] = await testDb.db
        .insert(tags)
        .values({ userId, name: "Trip" })
        .returning();

      const txn = (
        amount: bigint,
        options: Partial<{
          categoryId: string | null;
          accountId: string;
          date: string;
          status: "posted" | "pending" | "removed";
          excludeFromBudgets: boolean;
          plaidCategoryDetailed: string;
          plaidCategoryPrimary: string;
          deletedAt: Date;
          userId: string;
        }> = {},
      ) => ({
        userId: options.userId ?? userId,
        accountId: options.accountId ?? checking!.id,
        name: "txn",
        amount,
        date: options.date ?? "2026-10-15",
        status: options.status ?? ("posted" as const),
        categoryId:
          options.categoryId === undefined ? dining!.id : options.categoryId,
        excludeFromBudgets: options.excludeFromBudgets ?? false,
        ...(options.plaidCategoryDetailed
          ? { plaidCategoryDetailed: options.plaidCategoryDetailed }
          : {}),
        ...(options.plaidCategoryPrimary
          ? { plaidCategoryPrimary: options.plaidCategoryPrimary }
          : {}),
        ...(options.deletedAt ? { deletedAt: options.deletedAt } : {}),
      });
      const inserted = await testDb.db
        .insert(transactions)
        .values([
          txn(3000n, { status: "pending" }), // pending counts
          txn(10000n),
          txn(-2500n), // refund lowers spend
          txn(5000n, { categoryId: food!.id, accountId: card!.id }), // tagged below
          txn(-800n, { categoryId: travel!.id }), // spend may go negative
          txn(9999n, { categoryId: transfer!.id }),
          txn(-500000n, { categoryId: income!.id }),
          txn(1111n, { categoryId: excluded!.id }),
          txn(7777n, { excludeFromBudgets: true }),
          txn(20000n, {
            categoryId: null,
            accountId: checking!.id,
            plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
          }),
          txn(1200n, { categoryId: null }), // uncategorised
          // Uncategorised income and transfers are not refunds.
          txn(-250000n, { categoryId: null, plaidCategoryPrimary: "INCOME" }),
          txn(-40000n, {
            categoryId: null,
            plaidCategoryPrimary: "TRANSFER_IN",
          }),
          txn(30000n, {
            categoryId: null,
            plaidCategoryPrimary: "TRANSFER_OUT",
          }),
          // A categorised one follows its category, whatever Plaid said.
          txn(700n, {
            categoryId: travel!.id,
            plaidCategoryPrimary: "TRANSFER_OUT",
          }),
          txn(4444n, { date: "2026-10-31" }), // last day in
          txn(6666n, { date: "2026-11-01" }), // next month out
          txn(5555n, { date: "2026-09-30" }), // previous month out
          txn(3333n, { status: "removed" }),
          txn(2222n, { deletedAt: new Date() }),
          txn(8888n, { accountId: removed!.id }),
          txn(9000n, {
            userId: otherId,
            accountId: othersAccount!.id,
            categoryId: null,
          }),
          txn(1500n, { categoryId: gym!.id }), // paused plan, still spend
          txn(900n, { date: "2026-08-15" }), // before the budget started
        ])
        .returning();
      await testDb.db
        .insert(transactionTags)
        .values({ transactionId: inserted[3]!.id, tagId: tag!.id });

      const service = createBudgetsService({
        repository: createBudgetRepository(testDb.db),
        cache: {
          getOrCompute: async <T>(_key: unknown, compute: () => Promise<T>) =>
            compute(),
          invalidateUser: vi.fn(),
        } as never,
        getUserRevision: async () => 1n,
      });
      const usage = (
        month: string,
        filters: Partial<{
          accountIds: string[];
          categoryIds: string[];
          tagIds: string[];
        }> = {},
      ) =>
        service.getActiveBudgetUsage(userId, {
          month,
          accountIds: filters.accountIds ?? [],
          categoryIds: filters.categoryIds ?? [],
          tagIds: filters.tagIds ?? [],
        });
      const entry = (
        categoryId: string,
        parentId: string | null,
        plannedCents: string | null,
        spentCents: string,
      ) => ({ categoryId, parentId, plannedCents, spentCents });
      const byId = (rows: Array<{ categoryId: string }>) =>
        [...rows].sort((a, b) => a.categoryId.localeCompare(b.categoryId));

      const october = await usage("2026-10");
      expect(october).toMatchObject({
        month: "2026-10",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        uncategorizedSpentCents: "1200",
      });
      expect(byId(october.categories)).toEqual(
        byId([
          // 3000 pending + 10000 - 2500 refund + 4444 on the 31st
          entry(dining!.id, food!.id, "20000", "14944"),
          entry(food!.id, null, "50000", "5000"),
          entry(gym!.id, null, null, "1500"),
          entry(travel!.id, null, null, "-100"),
        ]),
      );

      // Filters narrow spend only; the plan is never filtered.
      const onCard = await usage("2026-10", { accountIds: [card!.id] });
      expect(byId(onCard.categories)).toEqual(
        byId([
          entry(dining!.id, food!.id, "20000", "0"),
          entry(food!.id, null, "50000", "5000"),
        ]),
      );
      expect(onCard.uncategorizedSpentCents).toBe("0");

      const foodGroup = await usage("2026-10", { categoryIds: [food!.id] });
      expect(byId(foodGroup.categories)).toEqual(
        byId([
          entry(dining!.id, food!.id, "20000", "14944"),
          entry(food!.id, null, "50000", "5000"),
        ]),
      );
      expect(foodGroup.uncategorizedSpentCents).toBe("0");

      const diningOnly = await usage("2026-10", { categoryIds: [dining!.id] });
      expect(byId(diningOnly.categories)).toEqual(
        byId([
          entry(dining!.id, food!.id, "20000", "14944"),
          entry(food!.id, null, "50000", "0"),
        ]),
      );

      const tagged = await usage("2026-10", { tagIds: [tag!.id] });
      expect(byId(tagged.categories)).toEqual(
        byId([
          entry(dining!.id, food!.id, "20000", "0"),
          entry(food!.id, null, "50000", "5000"),
        ]),
      );

      // A month before the budget started has no plan.
      const august = await usage("2026-08");
      expect(august.categories).toEqual([
        entry(dining!.id, food!.id, null, "900"),
      ]);

      // No active budget: 200 with spend, no plan.
      await testDb.db
        .update(budgets)
        .set({ isActive: false })
        .where(eq(budgets.id, budget!.id));
      const noBudget = await usage("2026-10");
      expect(byId(noBudget.categories)).toEqual(
        byId([
          entry(dining!.id, food!.id, null, "14944"),
          entry(food!.id, null, null, "5000"),
          entry(gym!.id, null, null, "1500"),
          entry(travel!.id, null, null, "-100"),
        ]),
      );
    } finally {
      await testDb.cleanup();
    }
  }, 60_000);

  it("leaves out a whole group that's off, and a single subcategory that's off (T-188)", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [savings, shopping] = await testDb.db
        .insert(categories)
        .values([
          { userId, name: "Savings", excludeFromBudgets: true },
          { userId, name: "Shopping" },
        ])
        .returning();
      // Emergency's own switch is on: its group decides.
      const [emergency, clothes, owed] = await testDb.db
        .insert(categories)
        .values([
          { userId, name: "Emergency", parentId: savings!.id },
          { userId, name: "Clothes", parentId: shopping!.id },
          {
            userId,
            name: "Owed to me",
            parentId: shopping!.id,
            excludeFromBudgets: true,
          },
        ])
        .returning();
      const [checking] = await testDb.db
        .insert(accounts)
        .values({
          userId,
          name: "Checking",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      const [budget] = await testDb.db
        .insert(budgets)
        .values({ userId, startDate: "2026-09-01" })
        .returning();
      await testDb.db.insert(budgetItems).values([
        { budgetId: budget!.id, categoryId: emergency!.id, amount: 30000n },
        { budgetId: budget!.id, categoryId: clothes!.id, amount: 10000n },
        { budgetId: budget!.id, categoryId: owed!.id, amount: 20000n },
      ]);
      const txn = (categoryId: string, amount: bigint) => ({
        userId,
        accountId: checking!.id,
        name: "txn",
        amount,
        date: "2026-10-15",
        status: "posted" as const,
        categoryId,
      });
      await testDb.db
        .insert(transactions)
        .values([
          txn(emergency!.id, 25000n),
          txn(clothes!.id, 4000n),
          txn(owed!.id, 20000n),
        ]);

      const repository = createBudgetRepository(testDb.db);
      const service = createBudgetsService({
        repository,
        cache: {
          getOrCompute: async <T>(_key: unknown, compute: () => Promise<T>) =>
            compute(),
          invalidateUser: vi.fn(),
        } as never,
        getUserRevision: async () => 1n,
      });
      const usage = () =>
        service.getActiveBudgetUsage(userId, {
          month: "2026-10",
          accountIds: [],
          categoryIds: [],
          tagIds: [],
        });
      // Only Clothes (and its group's roll-up) counts: no spend and no plan
      // from Emergency (group off) or Owed to me (off on its own).
      const off = await usage();
      expect(
        off.categories.find((row) => row.categoryId === clothes!.id),
      ).toMatchObject({ plannedCents: "10000", spentCents: "4000" });
      for (const left of [emergency!.id, savings!.id, owed!.id]) {
        expect(off.categories.some((row) => row.categoryId === left)).toBe(
          false,
        );
      }
      expect(
        await repository.getLeftOutCategoryIds(userId, [
          savings!.id,
          emergency!.id,
          shopping!.id,
          clothes!.id,
          owed!.id,
        ]),
      ).toEqual(new Set([savings!.id, emergency!.id, owed!.id]));

      // Switching the group back on restores Emergency's spend and its
      // stored plan; its own flag was never changed.
      await testDb.db
        .update(categories)
        .set({ excludeFromBudgets: false })
        .where(eq(categories.id, savings!.id));
      const on = await usage();
      expect(
        on.categories.find((row) => row.categoryId === emergency!.id),
      ).toMatchObject({ plannedCents: "30000", spentCents: "25000" });
      expect(on.categories.some((row) => row.categoryId === owed!.id)).toBe(
        false,
      );
    } finally {
      await testDb.cleanup();
    }
  }, 60_000);
});
