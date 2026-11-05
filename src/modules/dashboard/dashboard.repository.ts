import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

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
  /** Null for a bill with no scheduled occurrences yet. */
  occurrenceId: string | null;
  canonicalName: string;
  /** The user's name for the bill, else a card bill's account name. */
  displayName: string | null;
  /** The occurrence's effective due date (override else scheduled). */
  dueDate: string;
  /** The occurrence's effective amount (override else expected). */
  amount: bigint;
  cadence: string;
  status: "upcoming" | "overdue" | "processing";
  /** A payment is attached (posted or pending), so the money has left. */
  hasPayment: boolean;
  /** Paid from: the account it was marked paid from, else the bill's own. */
  payFromAccountId: string | null;
  billType: (typeof schema.billTypeEnum.enumValues)[number];
  /** For transfers, the account paid toward (a card for card payments). */
  toAccountId: string | null;
}>;
/** A visible checking or savings account. */
export type CashAccountRow = Readonly<{
  id: string;
  name: string;
  currentBalance: bigint | null;
}>;
export type NetWorthHistoryPointRow = Readonly<{
  date: string;
  netWorthCents: bigint;
  assetsCents: bigint;
  liabilitiesCents: bigint;
}>;

const addDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

/** Bill rows the Home summary may show; see DashboardRepository. */
async function getUpcomingBills(
  db: Db,
  userId: string,
  today: string,
  withinDays = 14,
): Promise<UpcomingBillRow[]> {
  const cutoff = addDays(today, withinDays);
  const liveSetup = and(
    eq(schema.billSetup.userId, userId),
    eq(schema.billSetup.status, "active"),
    eq(schema.billSetup.userConfirmed, true),
    eq(schema.billSetup.isIncome, false),
    isNull(schema.billSetup.deletedAt),
  );
  const dueDate = sql<string>`coalesce(${schema.billOccurrences.dueDateOverride}, ${schema.billOccurrences.dueDate})`;
  const amount =
    sql<bigint>`coalesce(${schema.billOccurrences.expectedAmountOverrideCents}, ${schema.billOccurrences.expectedAmountCents})`.mapWith(
      BigInt,
    );
  const occurrences = await db
    .select({
      id: schema.billSetup.id,
      occurrenceId: schema.billOccurrences.id,
      canonicalName: schema.billSetup.canonicalName,
      displayName: sql<
        string | null
      >`coalesce(${schema.billSetup.displayName}, ${schema.billSetup.accountLabel})`,
      dueDate,
      amount,
      cadence: schema.billSetup.cadence,
      status: schema.billOccurrences.status,
      hasPayment: sql<boolean>`(${schema.billOccurrences.linkedTransactionId} IS NOT NULL OR ${schema.billOccurrences.pendingTransactionId} IS NOT NULL)`,
      payFromAccountId: sql<
        string | null
      >`coalesce(${schema.billOccurrences.paidAccountId}, ${schema.billSetup.accountId})`,
      billType: schema.billSetup.billType,
      toAccountId: schema.billSetup.toAccountId,
    })
    .from(schema.billOccurrences)
    .innerJoin(
      schema.billSetup,
      eq(schema.billSetup.id, schema.billOccurrences.billSetupId),
    )
    .where(
      and(
        liveSetup,
        eq(schema.billOccurrences.userId, userId),
        sql`${amount} > 0`,
        sql`${dueDate} <= ${cutoff}`,
        or(
          // Waiting to be paid: overdue whatever its date (the sweep may not
          // have marked it yet), else due in the window.
          and(inArray(schema.billOccurrences.status, ["upcoming", "overdue"])),
          and(
            eq(schema.billOccurrences.status, "processing"),
            sql`${dueDate} >= ${today}`,
          ),
        ),
      ),
    );
  // A bill with nothing scheduled yet (not materialised) falls back to its
  // next expected date, as the Bills month view does.
  const unscheduled = await db
    .select({
      id: schema.billSetup.id,
      canonicalName: schema.billSetup.canonicalName,
      displayName: sql<
        string | null
      >`coalesce(${schema.billSetup.displayName}, ${schema.billSetup.accountLabel})`,
      dueDate: schema.billSetup.nextExpectedDate,
      amount: schema.billSetup.avgAmount,
      cadence: schema.billSetup.cadence,
      payFromAccountId: schema.billSetup.accountId,
      billType: schema.billSetup.billType,
      toAccountId: schema.billSetup.toAccountId,
    })
    .from(schema.billSetup)
    .where(
      and(
        liveSetup,
        sql`${schema.billSetup.avgAmount} > 0`,
        sql`${schema.billSetup.nextExpectedDate} >= ${today}`,
        sql`${schema.billSetup.nextExpectedDate} <= ${cutoff}`,
        sql`NOT EXISTS (SELECT 1 FROM ${schema.billOccurrences} WHERE ${schema.billOccurrences.billSetupId} = ${schema.billSetup.id})`,
      ),
    );
  return [
    ...occurrences.map((row) => ({
      ...row,
      status: row.status as UpcomingBillRow["status"],
    })),
    ...unscheduled.map((row) => ({
      ...row,
      occurrenceId: null,
      dueDate: row.dueDate!,
      status: "upcoming" as const,
      hasPayment: false,
    })),
  ].sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      (a.displayName ?? a.canonicalName).localeCompare(
        b.displayName ?? b.canonicalName,
      ),
  );
}

async function listCashAccounts(
  db: Db,
  userId: string,
): Promise<CashAccountRow[]> {
  const subtype = sql`coalesce(${schema.accounts.subtypeOverride}, ${schema.accounts.subtype})`;
  const name = sql<string>`coalesce(${schema.accounts.nameOverride}, ${schema.accounts.name})`;
  return db
    .select({
      id: schema.accounts.id,
      name,
      currentBalance: schema.accounts.currentBalance,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        isNull(schema.accounts.deletedAt),
        eq(schema.accounts.isHidden, false),
        eq(schema.accounts.type, "depository"),
        sql`${subtype} IN ('checking', 'savings')`,
      ),
    )
    .orderBy(asc(name), asc(schema.accounts.id));
}

async function getUserTimezone(db: Db, userId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.timezone ?? "UTC";
}

export type DashboardRepository = Readonly<{
  listAccounts: (userId: string) => Promise<DashboardAccountRow[]>;
  listCashAccounts: (userId: string) => Promise<CashAccountRow[]>;
  /** The user's IANA time zone, for calendar-month boundaries. */
  getUserTimezone: (userId: string) => Promise<string>;
  getSpendingTotals: (userId: string) => Promise<SpendingTotals>;
  /**
   * Unsettled bill occurrences due from `today` to `today + withinDays`,
   * plus overdue ones, earliest first. Paid, skipped and cancelled
   * occurrences and income are left out.
   */
  getUpcomingBills: (
    userId: string,
    today: string,
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
 * The `date` field also needs an explicit `::text` cast: a raw `sql` selection
 * has no Drizzle column mapper, so the `postgres` driver would otherwise
 * decode the OID-1082 `date` array element back into a JS `Date`, not the
 * `string` the `NetWorthHistoryPointRow` contract promises.
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
      date: sql<string>`(ARRAY_AGG(${schema.netWorthSnapshots.date} ORDER BY ${schema.netWorthSnapshots.date} DESC))[1]::text`,
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

  getUpcomingBills: (userId, today, withinDays) =>
    getUpcomingBills(getDb(), userId, today, withinDays),
  listCashAccounts: (userId) => listCashAccounts(getDb(), userId),
  getUserTimezone: (userId) => getUserTimezone(getDb(), userId),

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
    getUpcomingBills: (userId, today, withinDays) =>
      getUpcomingBills(db, userId, today, withinDays),
    listCashAccounts: (userId) => listCashAccounts(db, userId),
    getUserTimezone: (userId) => getUserTimezone(db, userId),

    getNetWorthHistory: (userId, dateFrom, dateTo, resolution) =>
      getNetWorthHistory(db, userId, dateFrom, dateTo, resolution),
  };
}
