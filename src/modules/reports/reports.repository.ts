import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";

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

export type ReportsRepository = Readonly<{
  getSpendingByCategory: (
    userId: string,
    dateFrom: string,
    dateTo: string,
  ) => Promise<SpendingByCategoryRow[]>;
  getMonthlySpending: (
    userId: string,
    dateFrom: string,
    dateTo: string,
  ) => Promise<MonthlyTotalRow[]>;
  getMonthlyIncome: (
    userId: string,
    dateFrom: string,
    dateTo: string,
  ) => Promise<MonthlyTotalRow[]>;
  getNetWorthSnapshots: (
    userId: string,
    dateFrom: string,
    dateTo: string,
  ) => Promise<NetWorthSnapshotRow[]>;
}>;

async function getSpendingByCategory(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
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
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.status, "posted"),
        sql`${schema.transactions.amount} > 0`,
        eq(schema.transactions.excludeFromReports, false),
        isNull(schema.transactions.deletedAt),
        gte(schema.transactions.date, dateFrom),
        lte(schema.transactions.date, dateTo),
      ),
    )
    .groupBy(schema.transactions.categoryId, schema.categories.name)
    .orderBy(sql`SUM(${schema.transactions.amount}) DESC`);
  return rows.map((row) => ({
    categoryId: row.categoryId,
    name: row.name,
    totalCents: row.totalCents ?? 0n,
  }));
}

async function getMonthlyTotal(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
  sign: "income" | "spending",
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
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.status, "posted"),
        predicate,
        eq(schema.transactions.excludeFromReports, false),
        isNull(schema.transactions.deletedAt),
        gte(schema.transactions.date, dateFrom),
        lte(schema.transactions.date, dateTo),
      ),
    )
    .groupBy(month)
    .orderBy(month);
  return rows.map((row) => ({
    month: row.month,
    totalCents: row.totalCents ?? 0n,
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
    netWorthCents: row.netWorthCents ?? 0n,
  }));
}

export const reportsRepository: ReportsRepository = {
  getSpendingByCategory: (userId, dateFrom, dateTo) =>
    getSpendingByCategory(getDb(), userId, dateFrom, dateTo),
  getMonthlySpending: (userId, dateFrom, dateTo) =>
    getMonthlyTotal(getDb(), userId, dateFrom, dateTo, "spending"),
  getMonthlyIncome: (userId, dateFrom, dateTo) =>
    getMonthlyTotal(getDb(), userId, dateFrom, dateTo, "income"),
  getNetWorthSnapshots: (userId, dateFrom, dateTo) =>
    getNetWorthSnapshots(getDb(), userId, dateFrom, dateTo),
};

/** Binds report reads to an explicit database client for integration tests. */
export function createReportsRepository(db: Db): ReportsRepository {
  return {
    getSpendingByCategory: (userId, dateFrom, dateTo) =>
      getSpendingByCategory(db, userId, dateFrom, dateTo),
    getMonthlySpending: (userId, dateFrom, dateTo) =>
      getMonthlyTotal(db, userId, dateFrom, dateTo, "spending"),
    getMonthlyIncome: (userId, dateFrom, dateTo) =>
      getMonthlyTotal(db, userId, dateFrom, dateTo, "income"),
    getNetWorthSnapshots: (userId, dateFrom, dateTo) =>
      getNetWorthSnapshots(db, userId, dateFrom, dateTo),
  };
}
