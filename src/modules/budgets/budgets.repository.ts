import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

export type BudgetRow = typeof schema.budgets.$inferSelect;
export type BudgetItemRow = typeof schema.budgetItems.$inferSelect;
export type BudgetDb = Db | DbTransaction;

/** Anchors a new budget to the process-local calendar date. */
export function budgetStartDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export type BudgetRepository = Readonly<{
  getActiveBudget: (userId: string, db?: BudgetDb) => Promise<BudgetRow | null>;
  getBudgetItems: (budgetId: string, db?: BudgetDb) => Promise<BudgetItemRow[]>;
  createBudget: (
    userId: string,
    input: {
      name?: string;
      items: Array<{ categoryId: string; amountCents: bigint }>;
    },
    db?: DbTransaction,
  ) => Promise<BudgetRow>;
  replaceBudgetItems: (
    budgetId: string,
    items: Array<{ categoryId: string; amountCents: bigint }>,
    db?: DbTransaction,
  ) => Promise<void>;
  upsertBudgetItem: (
    budgetId: string,
    categoryId: string,
    amountCents: bigint,
    db?: DbTransaction,
  ) => Promise<BudgetItemRow>;
  deleteBudgetItem: (
    budgetId: string,
    categoryId: string,
    db?: BudgetDb,
  ) => Promise<boolean>;
  categoryExists: (
    userId: string,
    categoryId: string,
    db?: BudgetDb,
  ) => Promise<boolean>;
  getCategoryNames: (
    userId: string,
    categoryIds: string[],
    db?: BudgetDb,
  ) => Promise<Map<string, string>>;
  getCategoryMedians: (
    userId: string,
    days?: number,
    db?: BudgetDb,
  ) => Promise<
    Array<{ categoryId: string; categoryName: string; medianCents: bigint }>
  >;
  getSpentByCategory: (
    userId: string,
    periodStart: string,
    periodEnd: string,
    db?: BudgetDb,
  ) => Promise<Array<{ categoryId: string; spentCents: bigint }>>;
  recordAudit: (
    audit: {
      userId: string;
      entityType: "budget" | "budget_item";
      entityId: string;
      action: "create" | "update" | "delete";
      source: string;
      before?: unknown;
      after?: unknown;
    },
    db?: BudgetDb,
  ) => Promise<void>;
}>;

const visibleCategory = (userId: string, categoryId: string) =>
  and(
    eq(schema.categories.id, categoryId),
    or(isNull(schema.categories.userId), eq(schema.categories.userId, userId)),
    isNull(schema.categories.archivedAt),
  );

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
}

export const budgetsRepository: BudgetRepository = {
  async getActiveBudget(userId, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.budgets)
      .where(
        and(
          eq(schema.budgets.userId, userId),
          eq(schema.budgets.isActive, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getBudgetItems(budgetId, db = getDb()) {
    return db
      .select()
      .from(schema.budgetItems)
      .where(eq(schema.budgetItems.budgetId, budgetId));
  },

  async createBudget(userId, input, db?) {
    if (db === undefined) {
      return getDb().transaction((tx) =>
        budgetsRepository.createBudget(userId, input, tx),
      );
    }
    await db
      .update(schema.budgets)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.budgets.userId, userId),
          eq(schema.budgets.isActive, true),
        ),
      );
    const startDate = budgetStartDate(new Date());
    const rows = await db
      .insert(schema.budgets)
      .values({
        userId,
        name: input.name ?? "My Budget",
        style: "flex",
        period: "monthly",
        startDate,
        isActive: true,
      })
      .returning();
    const budget = rows[0];
    if (!budget) throw new Error("Budget insert did not return a row");
    if (input.items.length > 0) {
      await db.insert(schema.budgetItems).values(
        input.items.map((item) => ({
          budgetId: budget.id,
          categoryId: item.categoryId,
          amount: item.amountCents,
          rolloverBehavior: "none" as const,
          rolloverBalance: 0n,
        })),
      );
    }
    return budget;
  },

  async replaceBudgetItems(budgetId, items, db?) {
    if (db === undefined) {
      return getDb().transaction((tx) =>
        budgetsRepository.replaceBudgetItems(budgetId, items, tx),
      );
    }
    await db
      .delete(schema.budgetItems)
      .where(eq(schema.budgetItems.budgetId, budgetId));
    if (items.length > 0) {
      await db.insert(schema.budgetItems).values(
        items.map((item) => ({
          budgetId,
          categoryId: item.categoryId,
          amount: item.amountCents,
          rolloverBehavior: "none" as const,
          rolloverBalance: 0n,
        })),
      );
    }
  },

  async upsertBudgetItem(budgetId, categoryId, amountCents, db?) {
    if (db === undefined) {
      return getDb().transaction((tx) =>
        budgetsRepository.upsertBudgetItem(
          budgetId,
          categoryId,
          amountCents,
          tx,
        ),
      );
    }
    await db
      .delete(schema.budgetItems)
      .where(
        and(
          eq(schema.budgetItems.budgetId, budgetId),
          eq(schema.budgetItems.categoryId, categoryId),
          isNull(schema.budgetItems.householdMemberId),
        ),
      );
    const rows = await db
      .insert(schema.budgetItems)
      .values({
        budgetId,
        categoryId,
        amount: amountCents,
        rolloverBehavior: "none",
        rolloverBalance: 0n,
      })
      .returning();
    const item = rows[0];
    if (!item) throw new Error("Budget item insert did not return a row");
    return item;
  },

  async deleteBudgetItem(budgetId, categoryId, db = getDb()) {
    const rows = await db
      .delete(schema.budgetItems)
      .where(
        and(
          eq(schema.budgetItems.budgetId, budgetId),
          eq(schema.budgetItems.categoryId, categoryId),
          isNull(schema.budgetItems.householdMemberId),
        ),
      )
      .returning({ id: schema.budgetItems.id });
    return rows.length > 0;
  },

  async categoryExists(userId, categoryId, db = getDb()) {
    const rows = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(visibleCategory(userId, categoryId))
      .limit(1);
    return rows.length > 0;
  },

  async getCategoryNames(userId, categoryIds, db = getDb()) {
    if (categoryIds.length === 0) return new Map();
    const rows = await db
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories)
      .where(
        and(
          or(
            eq(schema.categories.userId, userId),
            isNull(schema.categories.userId),
          ),
          isNull(schema.categories.archivedAt),
          sql`${schema.categories.id} IN (${sql.join(
            categoryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ),
      );
    return new Map(rows.map((row) => [row.id, row.name]));
  },

  async getCategoryMedians(userId, days = 90, db = getDb()) {
    const categories = await db
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories)
      .where(
        and(
          or(
            eq(schema.categories.userId, userId),
            isNull(schema.categories.userId),
          ),
          eq(schema.categories.isIncome, false),
          eq(schema.categories.isTransfer, false),
          eq(schema.categories.excludeFromBudgets, false),
          isNull(schema.categories.archivedAt),
        ),
      );
    if (categories.length === 0) return [];
    const categoryIds = categories.map((category) => category.id);
    const rows = await db.execute<{
      category_id: string;
      median_cents: string;
    }>(sql`
      SELECT category_id,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_cents)::bigint AS median_cents
      FROM transactions
      WHERE user_id = ${userId}
        AND deleted_at IS NULL
        AND exclude_from_budgets = false
        AND amount_cents > 0
        AND date >= CURRENT_DATE - (${days} || ' days')::interval
        AND category_id IN (${sql.join(
          categoryIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      GROUP BY category_id
      HAVING count(*) >= 1
      ORDER BY median_cents DESC
    `);
    const names = new Map(
      categories.map((category) => [category.id, category.name]),
    );
    return rows.map((row) => ({
      categoryId: row.category_id,
      categoryName: names.get(row.category_id) ?? "Unknown",
      medianCents: BigInt(row.median_cents),
    }));
  },

  async getSpentByCategory(userId, periodStart, periodEnd, db = getDb()) {
    const rows = await db
      .select({
        categoryId: schema.transactions.categoryId,
        spentCents: sql<string>`sum(${schema.transactions.amount})`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          isNull(schema.transactions.deletedAt),
          eq(schema.transactions.excludeFromBudgets, false),
          gte(schema.transactions.date, periodStart),
          lte(schema.transactions.date, periodEnd),
          sql`${schema.transactions.amount} > 0`,
        ),
      )
      .groupBy(schema.transactions.categoryId);
    return rows
      .filter(
        (row): row is typeof row & { categoryId: string } =>
          row.categoryId !== null,
      )
      .map((row) => ({
        categoryId: row.categoryId,
        spentCents: BigInt(row.spentCents ?? "0"),
      }));
  },

  async recordAudit(audit, db = getDb()) {
    await db.insert(schema.auditLog).values({
      userId: audit.userId,
      entityType: audit.entityType,
      entityId: audit.entityId,
      action: audit.action,
      source: audit.source,
      ...(audit.before === undefined
        ? {}
        : { beforeJson: jsonSafe(audit.before) }),
      ...(audit.after === undefined
        ? {}
        : { afterJson: jsonSafe(audit.after) }),
    });
  },
};

export const budgetRepository = budgetsRepository;

export function createBudgetRepository(db: Db): BudgetRepository {
  return {
    getActiveBudget: (userId, transaction) =>
      budgetsRepository.getActiveBudget(userId, transaction ?? db),
    getBudgetItems: (budgetId, transaction) =>
      budgetsRepository.getBudgetItems(budgetId, transaction ?? db),
    createBudget: (userId, input, transaction) =>
      transaction
        ? budgetsRepository.createBudget(userId, input, transaction)
        : db.transaction((tx) =>
            budgetsRepository.createBudget(userId, input, tx),
          ),
    replaceBudgetItems: (budgetId, items, transaction) =>
      transaction
        ? budgetsRepository.replaceBudgetItems(budgetId, items, transaction)
        : db.transaction((tx) =>
            budgetsRepository.replaceBudgetItems(budgetId, items, tx),
          ),
    upsertBudgetItem: (budgetId, categoryId, amount, transaction) =>
      transaction
        ? budgetsRepository.upsertBudgetItem(
            budgetId,
            categoryId,
            amount,
            transaction,
          )
        : db.transaction((tx) =>
            budgetsRepository.upsertBudgetItem(
              budgetId,
              categoryId,
              amount,
              tx,
            ),
          ),
    deleteBudgetItem: (budgetId, categoryId, transaction) =>
      budgetsRepository.deleteBudgetItem(
        budgetId,
        categoryId,
        transaction ?? db,
      ),
    categoryExists: (userId, categoryId, transaction) =>
      budgetsRepository.categoryExists(userId, categoryId, transaction ?? db),
    getCategoryNames: (userId, categoryIds, transaction) =>
      budgetsRepository.getCategoryNames(
        userId,
        categoryIds,
        transaction ?? db,
      ),
    getCategoryMedians: (userId, days, transaction) =>
      budgetsRepository.getCategoryMedians(userId, days, transaction ?? db),
    getSpentByCategory: (userId, start, end, transaction) =>
      budgetsRepository.getSpentByCategory(
        userId,
        start,
        end,
        transaction ?? db,
      ),
    recordAudit: (audit, transaction) =>
      budgetsRepository.recordAudit(audit, transaction ?? db),
  };
}
