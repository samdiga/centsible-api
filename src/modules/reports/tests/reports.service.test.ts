import { describe, expect, it, vi } from "vitest";

import { createResponseCache } from "../../../platform/cache/response-cache.js";
import { createReportsService } from "../reports.service.js";
import type { ReportsRepository } from "../reports.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function repository(): ReportsRepository {
  return {
    getSpendingByCategory: vi.fn(async () => []),
    getMonthlySpending: vi.fn(async () => [
      { month: "2026-05", totalCents: 100000n },
    ]),
    getMonthlyIncome: vi.fn(async () => [
      { month: "2026-05", totalCents: 400000n },
      { month: "2026-06", totalCents: 420000n },
    ]),
    getNetWorthSnapshots: vi.fn(async () => []),
  };
}

describe("reports service", () => {
  it("merges income and spending months and serializes signed integer cents", async () => {
    const service = createReportsService({
      repository: repository(),
      getUserRevision: async () => 1n,
    });

    const report = await service.getReport(USER_ID, {
      type: "income_vs_spending",
      dateFrom: "2026-05-01",
      dateTo: "2026-06-30",
    });

    expect(report.type).toBe("income_vs_spending");
    if (report.type !== "income_vs_spending") throw new Error("wrong report");
    expect(report.months[0]).toMatchObject({
      incomeCents: expect.any(String),
      spendingCents: expect.any(String),
    });
    expect(report.months).toEqual([
      { month: "2026-05", incomeCents: "400000", spendingCents: "100000" },
      { month: "2026-06", incomeCents: "420000", spendingCents: "0" },
    ]);
  });

  it("uses a normalized query and current user revision for five-minute caching", async () => {
    const repo = repository();
    const service = createReportsService({
      repository: repo,
      cache: createResponseCache(),
      getUserRevision: async () => 7n,
    });
    const query = {
      type: "monthly_spending" as const,
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
    };

    await service.getReport(USER_ID, query);
    await service.getReport(USER_ID, { ...query });

    expect(repo.getMonthlySpending).toHaveBeenCalledTimes(1);
  });
});
