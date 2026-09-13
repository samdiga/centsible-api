import {
  and,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db } from "../../platform/database/types.js";

export type SpendingByCategoryRow = Readonly<{
  categoryId: string;
  name: string;
  totalCents: bigint;
}>;
export type MonthlyTotalRow = Readonly<{ month: string; totalCents: bigint }>;
export type NetWorthSnapshotRow = Readonly<{
  month: string;
  netWorthCents: bigint;
}>;
export type CategoryTrendCategoryRow = Readonly<{
  categoryId: string;
  name: string;
  months: MonthlyTotalRow[];
}>;

export type ReportsRepository = Readonly<{
  getSpendingByCategory: (
    userId: string,
    dateFrom: string,
    dateTo: string,
    tagIds?: string[],
  ) => Promise<SpendingByCategoryRow[]>;
  getMonthlySpending: (
    userId: string,
    dateFrom: string,
    dateTo: string,
    tagIds?: string[],
  ) => Promise<MonthlyTotalRow[]>;
  getMonthlyIncome: (
    userId: string,
    dateFrom: string,
    dateTo: string,
    tagIds?: string[],
  ) => Promise<MonthlyTotalRow[]>;
  getNetWorthSnapshots: (
    userId: string,
    dateFrom: string,
    dateTo: string,
  ) => Promise<NetWorthSnapshotRow[]>;
  getCategoryTrend: (
    userId: string,
    dateFrom: string,
    dateTo: string,
    tagIds?: string[],
  ) => Promise<CategoryTrendCategoryRow[]>;
}>;

/** How many top categories `getCategoryTrend` breaks out individually. */
export const CATEGORY_TREND_TOP_N = 6;

function aggregateToBigInt(
  value: bigint | number | string | null | undefined,
): bigint {
  return value === null || value === undefined ? 0n : BigInt(value);
}

/**
 * The predicate shared by every transaction-based report query: the user's
 * own posted, non-deleted, report-eligible transactions in range, optionally
 * narrowed to those carrying at least one of `tagIds` (ANY/OR semantics).
 *
 * Deliberately excludes the amount-sign predicate (`> 0` vs `< 0`) — that
 * differs between spending and income call sites and stays at each call site.
 */
function baseReportConditions(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
  tagIds: string[] | undefined,
) {
  const conditions = [
    eq(schema.transactions.userId, userId),
    eq(schema.transactions.status, "posted"),
    eq(schema.transactions.excludeFromReports, false),
    isNull(schema.transactions.deletedAt),
    gte(schema.transactions.date, dateFrom),
    lte(schema.transactions.date, dateTo),
  ];
  if (tagIds && tagIds.length > 0) {
    conditions.push(
      inArray(
        schema.transactions.id,
        db
          .select({ id: schema.transactionTags.transactionId })
          .from(schema.transactionTags)
          .where(inArray(schema.transactionTags.tagId, tagIds)),
      ),
    );
  }
  return conditions;
}

async function getSpendingByCategory(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
  tagIds?: string[],
): Promise<SpendingByCategoryRow[]> {
  const rows = await db
    .select({
      categoryId: sql<string>`COALESCE(${schema.transactions.categoryId}::text, 'uncategorized')`,
      name: sql<string>`COALESCE(${schema.categories.name}, 'Uncategorized')`,
      totalCents: sql<
        bigint | null
      >`SUM(${schema.transactions.amount})::bigint`,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(
      and(
        ...baseReportConditions(db, userId, dateFrom, dateTo, tagIds),
        sql`${schema.transactions.amount} > 0`,
      ),
    )
    .groupBy(schema.transactions.categoryId, schema.categories.name)
    .orderBy(sql`SUM(${schema.transactions.amount}) DESC`);
  return rows.map((row) => ({
    categoryId: row.categoryId,
    name: row.name,
    totalCents: aggregateToBigInt(row.totalCents),
  }));
}

async function getMonthlyTotal(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
  sign: "income" | "spending",
  tagIds?: string[],
): Promise<MonthlyTotalRow[]> {
  const amount =
    sign === "income"
      ? sql<bigint | null>`ABS(SUM(${schema.transactions.amount}))::bigint`
      : sql<bigint | null>`SUM(${schema.transactions.amount})::bigint`;
  const predicate =
    sign === "income"
      ? sql`${schema.transactions.amount} < 0`
      : sql`${schema.transactions.amount} > 0`;
  const month = sql<string>`TO_CHAR(${schema.transactions.date}::date, 'YYYY-MM')`;
  const rows = await db
    .select({ month, totalCents: amount })
    .from(schema.transactions)
    .where(
      and(
        ...baseReportConditions(db, userId, dateFrom, dateTo, tagIds),
        predicate,
      ),
    )
    .groupBy(month)
    .orderBy(month);
  return rows.map((row) => ({
    month: row.month,
    totalCents: aggregateToBigInt(row.totalCents),
  }));
}

async function getNetWorthSnapshots(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
): Promise<NetWorthSnapshotRow[]> {
  const month = sql<string>`TO_CHAR(${schema.netWorthSnapshots.date}::date, 'YYYY-MM')`;
  const rows = await db
    .select({
      month,
      netWorthCents: sql<
        bigint | null
      >`(ARRAY_AGG(${schema.netWorthSnapshots.netWorth} ORDER BY ${schema.netWorthSnapshots.date} DESC))[1]::bigint`,
    })
    .from(schema.netWorthSnapshots)
    .where(
      and(
        eq(schema.netWorthSnapshots.userId, userId),
        gte(schema.netWorthSnapshots.date, dateFrom),
        lte(schema.netWorthSnapshots.date, dateTo),
      ),
    )
    .groupBy(month)
    .orderBy(month);
  return rows.map((row) => ({
    month: row.month,
    netWorthCents: aggregateToBigInt(row.netWorthCents),
  }));
}

async function getCategoryTrend(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
  tagIds?: string[],
): Promise<CategoryTrendCategoryRow[]> {
  const baseConditions = baseReportConditions(
    db,
    userId,
    dateFrom,
    dateTo,
    tagIds,
  );
  const spendingConditions = and(
    ...baseConditions,
    sql`${schema.transactions.amount} > 0`,
  );

  const topCategories = await db
    .select({
      categoryId: sql<string>`COALESCE(${schema.transactions.categoryId}::text, 'uncategorized')`,
      name: sql<string>`COALESCE(${schema.categories.name}, 'Uncategorized')`,
      totalCents: sql<
        bigint | null
      >`SUM(${schema.transactions.amount})::bigint`,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(spendingConditions)
    .groupBy(schema.transactions.categoryId, schema.categories.name)
    .orderBy(sql`SUM(${schema.transactions.amount}) DESC`)
    .limit(CATEGORY_TREND_TOP_N);

  if (topCategories.length === 0) return [];

  const topCategoryIds = topCategories.map((row) => row.categoryId);
  // `'uncategorized'` isn't a real category id — match it the same way
  // getSpendingByCategory's COALESCE does, via the categoryId IS NULL case.
  const realTopIds = topCategoryIds.filter((id) => id !== "uncategorized");
  const includesUncategorized = topCategoryIds.includes("uncategorized");

  // Built once with Drizzle's own combinators (`inArray`/`or`/`isNull`), not
  // raw `sql` string interpolation — this codebase never hand-writes IN/OR
  // as raw SQL, and Drizzle's tagged `sql` template doesn't reliably expand
  // an interpolated array into a parameterized IN list. `inTopSet` is reused
  // as-is for the top-category query and wrapped in `not(...)` for Other, so
  // the two queries are provably complementary rather than hand-duplicated.
  // `or()`'s return type is `SQL | undefined` in general (it can be called
  // with zero conditions), but never actually undefined here since exactly
  // two defined conditions are always passed in that branch — the `!`
  // reflects that, so `inTopSet` stays a concrete `SQL` for `not(inTopSet)`
  // below (which does not accept `undefined`).
  const inTopSet: SQL =
    realTopIds.length > 0
      ? includesUncategorized
        ? or(
            inArray(schema.transactions.categoryId, realTopIds),
            isNull(schema.transactions.categoryId),
          )!
        : inArray(schema.transactions.categoryId, realTopIds)
      : isNull(schema.transactions.categoryId); // only 'uncategorized' made the top set

  const month = sql<string>`TO_CHAR(${schema.transactions.date}::date, 'YYYY-MM')`;
  const categoryIdExpr = sql<string>`COALESCE(${schema.transactions.categoryId}::text, 'uncategorized')`;

  const monthlyRows = await db
    .select({
      categoryId: categoryIdExpr,
      month,
      totalCents: sql<
        bigint | null
      >`SUM(${schema.transactions.amount})::bigint`,
    })
    .from(schema.transactions)
    .where(and(spendingConditions, inTopSet))
    .groupBy(categoryIdExpr, month)
    .orderBy(month);

  const otherRows = await db
    .select({
      month,
      totalCents: sql<
        bigint | null
      >`SUM(${schema.transactions.amount})::bigint`,
    })
    .from(schema.transactions)
    .where(and(spendingConditions, not(inTopSet)))
    .groupBy(month)
    .orderBy(month);

  const monthsByCategory = new Map<string, MonthlyTotalRow[]>();
  for (const row of monthlyRows) {
    const list = monthsByCategory.get(row.categoryId) ?? [];
    list.push({
      month: row.month,
      totalCents: aggregateToBigInt(row.totalCents),
    });
    monthsByCategory.set(row.categoryId, list);
  }

  const result: CategoryTrendCategoryRow[] = topCategories.map(
    (category) => ({
      categoryId: category.categoryId,
      name: category.name,
      months: monthsByCategory.get(category.categoryId) ?? [],
    }),
  );

  if (otherRows.length > 0) {
    result.push({
      categoryId: "other",
      name: "Other",
      months: otherRows.map((row) => ({
        month: row.month,
        totalCents: aggregateToBigInt(row.totalCents),
      })),
    });
  }

  return result;
}

export const reportsRepository: ReportsRepository = {
  getSpendingByCategory: (userId, dateFrom, dateTo, tagIds) =>
    getSpendingByCategory(getDb(), userId, dateFrom, dateTo, tagIds),
  getMonthlySpending: (userId, dateFrom, dateTo, tagIds) =>
    getMonthlyTotal(getDb(), userId, dateFrom, dateTo, "spending", tagIds),
  getMonthlyIncome: (userId, dateFrom, dateTo, tagIds) =>
    getMonthlyTotal(getDb(), userId, dateFrom, dateTo, "income", tagIds),
  getNetWorthSnapshots: (userId, dateFrom, dateTo) =>
    getNetWorthSnapshots(getDb(), userId, dateFrom, dateTo),
  getCategoryTrend: (userId, dateFrom, dateTo, tagIds) =>
    getCategoryTrend(getDb(), userId, dateFrom, dateTo, tagIds),
};

/** Binds report reads to an explicit database client for integration tests. */
export function createReportsRepository(db: Db): ReportsRepository {
  return {
    getSpendingByCategory: (userId, dateFrom, dateTo, tagIds) =>
      getSpendingByCategory(db, userId, dateFrom, dateTo, tagIds),
    getMonthlySpending: (userId, dateFrom, dateTo, tagIds) =>
      getMonthlyTotal(db, userId, dateFrom, dateTo, "spending", tagIds),
    getMonthlyIncome: (userId, dateFrom, dateTo, tagIds) =>
      getMonthlyTotal(db, userId, dateFrom, dateTo, "income", tagIds),
    getNetWorthSnapshots: (userId, dateFrom, dateTo) =>
      getNetWorthSnapshots(db, userId, dateFrom, dateTo),
    getCategoryTrend: (userId, dateFrom, dateTo, tagIds) =>
      getCategoryTrend(db, userId, dateFrom, dateTo, tagIds),
  };
}
