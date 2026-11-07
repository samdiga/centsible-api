import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import { getUserRevision } from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import {
  projectCardPayments,
  type CardPaymentProjection,
} from "../forecast/index.js";
import { isMarkedPaid, moneyStillToLeave } from "./bill-money.js";
import { computeNetWorth } from "./net-worth.js";
import {
  computeSafeToSpendByAccount,
  needsCardProjections,
} from "./safe-to-spend-by-account.js";
import {
  dashboardRepository,
  type DashboardRepository,
  type UpcomingBillRow,
} from "./dashboard.repository.js";
import type {
  DashboardSummary,
  NetWorthHistoryResponse,
} from "./dashboard.schemas.js";
import { billName } from "../bills/bill-name.js";

export type DashboardService = Readonly<{
  getSummary: (userId: string) => Promise<DashboardSummary>;
  getNetWorthHistory: (
    userId: string,
    dateFrom: string,
    dateTo: string,
    resolution: "daily" | "weekly" | "monthly",
  ) => Promise<NetWorthHistoryResponse>;
}>;

export type DashboardServiceDependencies = Readonly<{
  repository?: DashboardRepository;
  cache?: Pick<ResponseCache, "getOrCompute">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  now?: () => Date;
  projectCardPayments?: (
    userId: string,
    today: string,
    through: string,
  ) => Promise<CardPaymentProjection[]>;
  logger?: Readonly<{
    error: (bindings: Record<string, unknown>, message: string) => unknown;
  }>;
}>;

/**
 * Enough for the large Upcoming bills widget; Home shows the first five.
 * Safe-to-spend counts every bill due this week regardless.
 */
const MAX_UPCOMING_BILLS = 10;
/** Home lists bills due in the next two weeks. */
const UPCOMING_LIST_DAYS = 14;

/**
 * The first MAX_UPCOMING_BILLS bills still to pay, with any marked-paid ones
 * that fall among them, so hiding marked-paid bills never leaves Home short.
 */
function takeUpcoming(bills: readonly UpcomingBillRow[]): UpcomingBillRow[] {
  const taken: UpcomingBillRow[] = [];
  let unpaid = 0;
  for (const bill of bills) {
    if (unpaid === MAX_UPCOMING_BILLS) break;
    taken.push(bill);
    if (!isMarkedPaid(bill)) unpaid += 1;
  }
  return taken;
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const addDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return utcDate(next);
};

const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );

/** The last day of the month `now` falls in, in `timezone`. */
function monthEndIn(now: Date, timezone: string): string {
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // An unknown zone name in the users row: fall back to UTC.
    local = utcDate(now);
  }
  const [year, month] = local.split("-").map(Number);
  return utcDate(new Date(Date.UTC(year!, month!, 0)));
}

/** Creates the cached read model behind GET /dashboard/summary. */
export function createDashboardService(
  dependencies: DashboardServiceDependencies = {},
): DashboardService {
  const repository = dependencies.repository ?? dashboardRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const now = dependencies.now ?? (() => new Date());
  const projectCards = dependencies.projectCardPayments ?? projectCardPayments;
  const serviceLogger = dependencies.logger ?? runtimeLogger;

  return {
    async getSummary(userId) {
      const [revision, timezone] = await Promise.all([
        readRevision(userId),
        repository.getUserTimezone(userId),
      ]);
      const instant = now();
      const date = utcDate(instant);
      const periodEnd = monthEndIn(instant, timezone);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/dashboard/summary",
          query: { periodEnd: [periodEnd] },
          revision,
          date,
          timezone,
        },
        async () => {
          const [accounts, cashAccounts, spendingTotals, bills] =
            await Promise.all([
              repository.listAccounts(userId),
              repository.listCashAccounts(userId),
              repository.getSpendingTotals(userId),
              repository.getUpcomingBills(
                userId,
                date,
                Math.max(UPCOMING_LIST_DAYS, daysBetween(date, periodEnd)),
              ),
            ]);
          const cutoff = new Date(`${date}T00:00:00.000Z`);
          cutoff.setUTCDate(cutoff.getUTCDate() + 7);
          const cutoffDate = utcDate(cutoff);
          // Money that hasn't left yet still comes out of safe-to-spend: a
          // bill marked paid by hand stays in until its payment shows up.
          const billsDueThisWeek = bills.filter(
            (bill) => bill.dueDate <= cutoffDate && moneyStillToLeave(bill),
          );
          const upcomingBillsTotal = billsDueThisWeek.reduce(
            (total, bill) => total + bill.amount,
            0n,
          );
          // The list is what's still to pay, plus bills marked paid by hand
          // (flagged, so the app can hide them). A payment already attached
          // at the bank is never listed.
          const listEnd = addDays(date, UPCOMING_LIST_DAYS);
          const listable = bills.filter(
            (bill) => bill.dueDate <= listEnd && moneyStillToLeave(bill),
          );
          const upcomingBills = takeUpcoming(listable);
          const netWorth = computeNetWorth(accounts, upcomingBillsTotal);
          const byAccount = computeSafeToSpendByAccount({
            accounts: cashAccounts,
            bills,
            cardPayments: needsCardProjections(bills, periodEnd)
              ? await projectCards(userId, date, periodEnd).catch(
                  (error: unknown) => {
                    // Card payments then count their statement amount.
                    serviceLogger.error(
                      { error, userId },
                      "Card payment projection failed",
                    );
                    return [];
                  },
                )
              : [],
            periodEnd,
          });

          return {
            netWorth: netWorth.netWorth.toString(),
            assets: netWorth.assets.toString(),
            liabilities: netWorth.liabilities.toString(),
            safeToSpend: netWorth.safeToSpend.toString(),
            safeToSpendHasBills: billsDueThisWeek.length > 0,
            spendingThisMonth: spendingTotals.thisMonth.toString(),
            spendingLastMonth: spendingTotals.lastMonth.toString(),
            upcomingBills: upcomingBills.map((bill) => ({
              id: bill.id,
              occurrenceId: bill.occurrenceId,
              canonicalName: bill.canonicalName,
              name: billName(bill),
              nextExpectedDate: bill.dueDate,
              avgAmount: bill.amount.toString(),
              cadence: bill.cadence,
              markedPaid: isMarkedPaid(bill),
            })),
            upcomingBillsUnpaidCount: listable.filter(
              (bill) => !isMarkedPaid(bill),
            ).length,
            safeToSpendByAccount: byAccount.accounts.map((row) => ({
              accountId: row.accountId,
              name: row.name,
              balanceCents: row.balanceCents.toString(),
              billsDueCents: row.billsDueCents.toString(),
              safeToSpendCents: row.safeToSpendCents.toString(),
              billCount: row.billCount,
            })),
            unassignedBillCount: byAccount.unassignedBillCount,
            periodEnd,
          };
        },
      );
    },

    async getNetWorthHistory(userId, dateFrom, dateTo, resolution) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/dashboard/net-worth/history",
          query: {
            dateFrom: [dateFrom],
            dateTo: [dateTo],
            resolution: [resolution],
          },
          revision,
          date: utcDate(now()),
        },
        async () => {
          const points = await repository.getNetWorthHistory(
            userId,
            dateFrom,
            dateTo,
            resolution,
          );
          return {
            points: points.map((point) => ({
              date: point.date,
              netWorthCents: point.netWorthCents.toString(),
              assetsCents: point.assetsCents.toString(),
              liabilitiesCents: point.liabilitiesCents.toString(),
            })),
          };
        },
      );
    },
  };
}
