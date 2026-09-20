import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db } from "../../platform/database/types.js";

export type DashboardAccountRow = Readonly<{
  type: (typeof schema.accountTypeEnum.enumValues)[number];
  currentBalance: bigint | null;
  availableBalance: bigint | null;
  excludeFromNetWorth: boolean;
  excludeFromForecast: boolean;
}>;
export type SpendingTotals = Readonly<{
  thisMonth: bigint;
  lastMonth: bigint;
}>;
export type UpcomingBillRow = Readonly<{
  id: string;
  canonicalName: string;
  nextExpectedDate: string | null;
  avgAmount: bigint;
  cadence: string;
}>;
export type NetWorthHistoryPointRow = Readonly<{
  date: string;
  netWorthCents: bigint;
  assetsCents: bigint;
  liabilitiesCents: bigint;
}>;

export type DashboardRepository = Readonly<{
  listAccounts: (userId: string) => Promise<DashboardAccountRow[]>;
  getSpendingTotals: (userId: string) => Promise<SpendingTotals>;
  getUpcomingBills: (
    userId: string,
    withinDays?: number,
  ) => Promise<UpcomingBillRow[]>;
  getNetWorthHistory: (
    userId: string,
    dateFrom: string,
    dateTo: string,
    resolution: "daily" | "weekly" | "monthly",
  ) => Promise<NetWorthHistoryPointRow[]>;
}>;

function monthBounds(now: Date) {
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
  const lastMonthEndDate = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthEnd = `${lastMonthEndDate.getFullYear()}-${String(lastMonthEndDate.getMonth() + 1).padStart(2, "0")}-${String(lastMonthEndDate.getDate()).padStart(2, "0")}`;
  return { thisMonthStart, lastMonthStart, lastMonthEnd };
}

async function getNetWorthHistoryDaily(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
): Promise<NetWorthHistoryPointRow[]> {
  return db
    .select({
      date: schema.netWorthSnapshots.date,
      netWorthCents: schema.netWorthSnapshots.netWorth,
      assetsCents: schema.netWorthSnapshots.totalAssets,
      liabilitiesCents: schema.netWorthSnapshots.totalLiabilities,
    })
    .from(schema.netWorthSnapshots)
    .where(
      and(
        eq(schema.netWorthSnapshots.userId, userId),
        gte(schema.netWorthSnapshots.date, dateFrom),
        lte(schema.netWorthSnapshots.date, dateTo),
      ),
    )
    .orderBy(asc(schema.netWorthSnapshots.date));
}

/**
 * Weekly/monthly: the *last real snapshot date* within each bucket, via the
 * same `ARRAY_AGG(...ORDER BY date DESC)[1]` technique the existing monthly
 * `reports` net_worth type already uses (`reports.repository.ts`) — never a
 * synthetic bucket-start date. A `GROUP BY` has no default row order, so this
 * always ends with `.orderBy(bucket)` explicitly (spec §4.3's ordering
 * contract). `bucket` only ever groups rows that exist, so every aggregate
 * here is over at least one row — `::bigint` cast is safe with no null case
 * to guard, unlike `reports`' SUM-based aggregates over a possibly-empty set.
 */
async function getNetWorthHistoryBucketed(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
  bucket: ReturnType<typeof sql<string>>,
): Promise<NetWorthHistoryPointRow[]> {
  const rows = await db
    .select({
      date: sql<string>`(ARRAY_AGG(${schema.netWorthSnapshots.date} ORDER BY ${schema.netWorthSnapshots.date} DESC))[1]`,
      netWorthCents: sql<string>`(ARRAY_AGG(${schema.netWorthSnapshots.netWorth} ORDER BY ${schema.netWorthSnapshots.date} DESC))[1]::bigint`,
      assetsCents: sql<string>`(ARRAY_AGG(${schema.netWorthSnapshots.totalAssets} ORDER BY ${schema.netWorthSnapshots.date} DESC))[1]::bigint`,
      liabilitiesCents: sql<string>`(ARRAY_AGG(${schema.netWorthSnapshots.totalLiabilities} ORDER BY ${schema.netWorthSnapshots.date} DESC))[1]::bigint`,
    })
    .from(schema.netWorthSnapshots)
    .where(
      and(
        eq(schema.netWorthSnapshots.userId, userId),
        gte(schema.netWorthSnapshots.date, dateFrom),
        lte(schema.netWorthSnapshots.date, dateTo),
      ),
    )
    .groupBy(bucket)
    .orderBy(bucket);
  return rows.map((row) => ({
    date: row.date,
    netWorthCents: BigInt(row.netWorthCents),
    assetsCents: BigInt(row.assetsCents),
    liabilitiesCents: BigInt(row.liabilitiesCents),
  }));
}

async function getNetWorthHistory(
  db: Db,
  userId: string,
  dateFrom: string,
  dateTo: string,
  resolution: "daily" | "weekly" | "monthly",
): Promise<NetWorthHistoryPointRow[]> {
  if (resolution === "daily")
    return getNetWorthHistoryDaily(db, userId, dateFrom, dateTo);
  const bucket =
    resolution === "weekly"
      ? sql<string>`date_trunc('week', ${schema.netWorthSnapshots.date}::date)`
      : sql<string>`TO_CHAR(${schema.netWorthSnapshots.date}::date, 'YYYY-MM')`;
  return getNetWorthHistoryBucketed(db, userId, dateFrom, dateTo, bucket);
}

export const dashboardRepository: DashboardRepository = {
  async listAccounts(userId) {
    return getDb()
      .select({
        type: schema.accounts.type,
        currentBalance: schema.accounts.currentBalance,
        availableBalance: schema.accounts.availableBalance,
        excludeFromNetWorth: schema.accounts.excludeFromNetWorth,
        excludeFromForecast: schema.accounts.excludeFromForecast,
      })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
        ),
      );
  },

  async getSpendingTotals(userId) {
    const { thisMonthStart, lastMonthStart, lastMonthEnd } = monthBounds(
      new Date(),
    );
    const [row] = await getDb()
      .select({
        thisMonth: sql<string>`COALESCE(SUM(CASE WHEN ${schema.transactions.date} >= ${thisMonthStart} THEN ${schema.transactions.amount} ELSE 0 END), 0)::text`,
        lastMonth: sql<string>`COALESCE(SUM(CASE WHEN ${schema.transactions.date} >= ${lastMonthStart} AND ${schema.transactions.date} <= ${lastMonthEnd} THEN ${schema.transactions.amount} ELSE 0 END), 0)::text`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.status, "posted"),
          sql`${schema.transactions.amount} > 0`,
          eq(schema.transactions.excludeFromReports, false),
          isNull(schema.transactions.deletedAt),
          sql`${schema.transactions.date} >= ${lastMonthStart}`,
        ),
      );
    return {
      thisMonth: BigInt(row?.thisMonth ?? "0"),
      lastMonth: BigInt(row?.lastMonth ?? "0"),
    };
  },

  async getUpcomingBills(userId, withinDays = 14) {
    const today = new Date();
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() + withinDays);
    const todayString = today.toISOString().slice(0, 10);
    const cutoffString = cutoff.toISOString().slice(0, 10);
    return getDb()
      .select({
        id: schema.billSetup.id,
        canonicalName: schema.billSetup.canonicalName,
        nextExpectedDate: schema.billSetup.nextExpectedDate,
        avgAmount: schema.billSetup.avgAmount,
        cadence: schema.billSetup.cadence,
      })
      .from(schema.billSetup)
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          eq(schema.billSetup.status, "active"),
          eq(schema.billSetup.userConfirmed, true),
          eq(schema.billSetup.isIncome, false),
          isNull(schema.billSetup.deletedAt),
          sql`${schema.billSetup.nextExpectedDate} >= ${todayString}`,
          sql`${schema.billSetup.nextExpectedDate} <= ${cutoffString}`,
        ),
      )
      .orderBy(schema.billSetup.nextExpectedDate)
      .limit(5);
  },

  getNetWorthHistory: (userId, dateFrom, dateTo, resolution) =>
    getNetWorthHistory(getDb(), userId, dateFrom, dateTo, resolution),
};

/** Binds dashboard reads to an explicit database client for integration tests. */
export function createDashboardRepository(db: Db): DashboardRepository {
  return {
    listAccounts: async (userId) =>
      db
        .select({
          type: schema.accounts.type,
          currentBalance: schema.accounts.currentBalance,
          availableBalance: schema.accounts.availableBalance,
          excludeFromNetWorth: schema.accounts.excludeFromNetWorth,
          excludeFromForecast: schema.accounts.excludeFromForecast,
        })
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.userId, userId),
            isNull(schema.accounts.deletedAt),
          ),
        ),
    getSpendingTotals: async (userId) => {
      const { thisMonthStart, lastMonthStart, lastMonthEnd } = monthBounds(
        new Date(),
      );
      const [row] = await db
        .select({
          thisMonth: sql<string>`COALESCE(SUM(CASE WHEN ${schema.transactions.date} >= ${thisMonthStart} THEN ${schema.transactions.amount} ELSE 0 END), 0)::text`,
          lastMonth: sql<string>`COALESCE(SUM(CASE WHEN ${schema.transactions.date} >= ${lastMonthStart} AND ${schema.transactions.date} <= ${lastMonthEnd} THEN ${schema.transactions.amount} ELSE 0 END), 0)::text`,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.status, "posted"),
            sql`${schema.transactions.amount} > 0`,
            eq(schema.transactions.excludeFromReports, false),
            isNull(schema.transactions.deletedAt),
            sql`${schema.transactions.date} >= ${lastMonthStart}`,
          ),
        );
      return {
        thisMonth: BigInt(row?.thisMonth ?? "0"),
        lastMonth: BigInt(row?.lastMonth ?? "0"),
      };
    },
    getUpcomingBills: async (userId, withinDays = 14) => {
      const today = new Date();
      const cutoff = new Date(today);
      cutoff.setDate(cutoff.getDate() + withinDays);
      const todayString = today.toISOString().slice(0, 10);
      const cutoffString = cutoff.toISOString().slice(0, 10);
      return db
        .select({
          id: schema.billSetup.id,
          canonicalName: schema.billSetup.canonicalName,
          nextExpectedDate: schema.billSetup.nextExpectedDate,
          avgAmount: schema.billSetup.avgAmount,
          cadence: schema.billSetup.cadence,
        })
        .from(schema.billSetup)
        .where(
          and(
            eq(schema.billSetup.userId, userId),
            eq(schema.billSetup.status, "active"),
            eq(schema.billSetup.userConfirmed, true),
            eq(schema.billSetup.isIncome, false),
            isNull(schema.billSetup.deletedAt),
            sql`${schema.billSetup.nextExpectedDate} >= ${todayString}`,
            sql`${schema.billSetup.nextExpectedDate} <= ${cutoffString}`,
          ),
        )
        .orderBy(schema.billSetup.nextExpectedDate)
        .limit(5);
    },

    getNetWorthHistory: (userId, dateFrom, dateTo, resolution) =>
      getNetWorthHistory(db, userId, dateFrom, dateTo, resolution),
  };
}
