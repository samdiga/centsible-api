import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import { getUserRevision } from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import { computeNetWorth } from "./net-worth.js";
import {
  dashboardRepository,
  type DashboardRepository,
} from "./dashboard.repository.js";
import type {
  DashboardSummary,
  NetWorthHistoryResponse,
} from "./dashboard.schemas.js";

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
}>;

/** Home shows the next few; safe-to-spend counts every bill due this week. */
const MAX_UPCOMING_BILLS = 5;

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
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

  return {
    async getSummary(userId) {
      const revision = await readRevision(userId);
      const date = utcDate(now());
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/dashboard/summary",
          query: {},
          revision,
          date,
        },
        async () => {
          const [accounts, spendingTotals, bills] = await Promise.all([
            repository.listAccounts(userId),
            repository.getSpendingTotals(userId),
            repository.getUpcomingBills(userId, date),
          ]);
          const cutoff = new Date(`${date}T00:00:00.000Z`);
          cutoff.setUTCDate(cutoff.getUTCDate() + 7);
          const cutoffDate = utcDate(cutoff);
          // Money that hasn't left yet still comes out of safe-to-spend: a
          // bill marked paid by hand stays in until its payment shows up.
          const billsDueThisWeek = bills.filter(
            (bill) =>
              bill.dueDate <= cutoffDate &&
              (bill.status !== "processing" || !bill.hasPayment),
          );
          const upcomingBillsTotal = billsDueThisWeek.reduce(
            (total, bill) => total + bill.amount,
            0n,
          );
          // The list is what's still to pay; "Payment pending" is not.
          const upcomingBills = bills
            .filter((bill) => bill.status !== "processing")
            .slice(0, MAX_UPCOMING_BILLS);
          const netWorth = computeNetWorth(accounts, upcomingBillsTotal);

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
              name: bill.displayName ?? bill.canonicalName,
              nextExpectedDate: bill.dueDate,
              avgAmount: bill.amount.toString(),
              cadence: bill.cadence,
            })),
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
