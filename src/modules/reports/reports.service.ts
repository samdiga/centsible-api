import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import { getUserRevision } from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import {
  reportsRepository,
  type ReportsRepository,
} from "./reports.repository.js";
import type { ReportQuery, ReportSummary } from "./reports.schemas.js";

export type ReportsService = Readonly<{
  getReport: (userId: string, query: ReportQuery) => Promise<ReportSummary>;
}>;
export type ReportsServiceDependencies = Readonly<{
  repository?: ReportsRepository;
  cache?: Pick<ResponseCache, "getOrCompute">;
  getUserRevision?: (userId: string) => Promise<bigint>;
}>;

function normalizedCacheQuery(query: ReportQuery): Record<string, string[]> {
  return {
    dateFrom: [query.dateFrom],
    dateTo: [query.dateTo],
    type: [query.type],
  };
}

/** Creates the cached read model behind GET /reports/summary. */
export function createReportsService(
  dependencies: ReportsServiceDependencies = {},
): ReportsService {
  const repository = dependencies.repository ?? reportsRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));

  return {
    async getReport(userId, query) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/reports/summary",
          query: normalizedCacheQuery(query),
          revision,
        },
        async () => {
          const { type, dateFrom, dateTo } = query;
          switch (type) {
            case "spending_by_category": {
              const categories = await repository.getSpendingByCategory(
                userId,
                dateFrom,
                dateTo,
              );
              return {
                type,
                categories: categories.map((category) => ({
                  ...category,
                  totalCents: category.totalCents.toString(),
                })),
              };
            }
            case "monthly_spending": {
              const months = await repository.getMonthlySpending(
                userId,
                dateFrom,
                dateTo,
              );
              return {
                type,
                months: months.map((month) => ({
                  ...month,
                  totalCents: month.totalCents.toString(),
                })),
              };
            }
            case "income_vs_spending": {
              const [spending, income] = await Promise.all([
                repository.getMonthlySpending(userId, dateFrom, dateTo),
                repository.getMonthlyIncome(userId, dateFrom, dateTo),
              ]);
              const months = new Set([
                ...spending.map((month) => month.month),
                ...income.map((month) => month.month),
              ]);
              const incomeByMonth = new Map(
                income.map((month) => [month.month, month.totalCents]),
              );
              const spendingByMonth = new Map(
                spending.map((month) => [month.month, month.totalCents]),
              );
              return {
                type,
                months: [...months].sort().map((month) => ({
                  month,
                  incomeCents: (incomeByMonth.get(month) ?? 0n).toString(),
                  spendingCents: (spendingByMonth.get(month) ?? 0n).toString(),
                })),
              };
            }
            case "net_worth": {
              const snapshots = await repository.getNetWorthSnapshots(
                userId,
                dateFrom,
                dateTo,
              );
              return {
                type,
                snapshots: snapshots.map((snapshot) => ({
                  ...snapshot,
                  netWorthCents: snapshot.netWorthCents.toString(),
                })),
              };
            }
          }
        },
      );
    },
  };
}
