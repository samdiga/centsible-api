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
import type { DashboardSummary } from "./dashboard.schemas.js";

export type DashboardService = Readonly<{
  getSummary: (userId: string) => Promise<DashboardSummary>;
}>;

export type DashboardServiceDependencies = Readonly<{
  repository?: DashboardRepository;
  cache?: Pick<ResponseCache, "getOrCompute">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  now?: () => Date;
}>;

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
          const [accounts, spendingTotals, upcomingBills] = await Promise.all([
            repository.listAccounts(userId),
            repository.getSpendingTotals(userId),
            repository.getUpcomingBills(userId),
          ]);
          const cutoff = new Date(`${date}T00:00:00.000Z`);
          cutoff.setUTCDate(cutoff.getUTCDate() + 7);
          const cutoffDate = utcDate(cutoff);
          const billsDueThisWeek = upcomingBills.filter(
            (bill) =>
              bill.nextExpectedDate !== null &&
              bill.nextExpectedDate <= cutoffDate,
          );
          const upcomingBillsTotal = billsDueThisWeek.reduce(
            (total, bill) => total + bill.avgAmount,
            0n,
          );
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
              canonicalName: bill.canonicalName,
              nextExpectedDate: bill.nextExpectedDate ?? "",
              avgAmount: bill.avgAmount.toString(),
              cadence: bill.cadence,
            })),
          };
        },
      );
    },
  };
}
