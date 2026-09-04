import { and, eq, isNull, sql } from "drizzle-orm";

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

export type DashboardRepository = Readonly<{
  listAccounts: (userId: string) => Promise<DashboardAccountRow[]>;
  getSpendingTotals: (userId: string) => Promise<SpendingTotals>;
  getUpcomingBills: (
    userId: string,
    withinDays?: number,
  ) => Promise<UpcomingBillRow[]>;
}>;

function monthBounds(now: Date) {
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
  const lastMonthEndDate = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthEnd = `${lastMonthEndDate.getFullYear()}-${String(lastMonthEndDate.getMonth() + 1).padStart(2, "0")}-${String(lastMonthEndDate.getDate()).padStart(2, "0")}`;
  return { thisMonthStart, lastMonthStart, lastMonthEnd };
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
  };
}
