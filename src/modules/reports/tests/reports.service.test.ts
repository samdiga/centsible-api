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
    getCategoryTrend: vi.fn(async () => [
      {
        categoryId: "cat-1",
        name: "Groceries",
        months: [{ month: "2026-05", totalCents: 9000n }],
      },
    ]),
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

  it("shares normalized query keys but separates changed queries and revisions", async () => {
    const repo = repository();
    let revision = 7n;
    const service = createReportsService({
      repository: repo,
      cache: createResponseCache(),
      getUserRevision: async () => revision,
    });
    const query = {
      type: "monthly_spending" as const,
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
    };

    await service.getReport(USER_ID, query);
    await service.getReport(USER_ID, {
      dateTo: query.dateTo,
      type: query.type,
      dateFrom: query.dateFrom,
    });
    await service.getReport(USER_ID, { ...query, dateTo: "2026-06-01" });
    revision = 8n;
    await service.getReport(USER_ID, { ...query, dateTo: "2026-06-01" });

    expect(repo.getMonthlySpending).toHaveBeenCalledTimes(3);
  });

  it("serves category_trend and serializes its nested month totals", async () => {
    const service = createReportsService({
      repository: repository(),
      getUserRevision: async () => 1n,
    });

    const report = await service.getReport(USER_ID, {
      type: "category_trend",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
    });

    expect(report).toEqual({
      type: "category_trend",
      categories: [
        {
          categoryId: "cat-1",
          name: "Groceries",
          months: [{ month: "2026-05", totalCents: "9000" }],
        },
      ],
    });
  });

  it("passes tagIds through to the repository for a tag-eligible report type", async () => {
    const repo = repository();
    const service = createReportsService({
      repository: repo,
      getUserRevision: async () => 1n,
    });

    await service.getReport(USER_ID, {
      type: "spending_by_category",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      tagIds: ["tag-a"],
    });

    expect(repo.getSpendingByCategory).toHaveBeenCalledWith(
      USER_ID,
      "2026-05-01",
      "2026-05-31",
      ["tag-a"],
    );
  });

  it("never passes tagIds to getNetWorthSnapshots even when supplied", async () => {
    const repo = repository();
    const service = createReportsService({
      repository: repo,
      getUserRevision: async () => 1n,
    });

    await service.getReport(USER_ID, {
      type: "net_worth",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      tagIds: ["tag-a"],
    });

    expect(repo.getNetWorthSnapshots).toHaveBeenCalledWith(
      USER_ID,
      "2026-05-01",
      "2026-05-31",
    );
  });

  it("separates cache entries that differ only by tagIds", async () => {
    const repo = repository();
    const service = createReportsService({
      repository: repo,
      cache: createResponseCache(),
      getUserRevision: async () => 1n,
    });
    const base = {
      type: "spending_by_category" as const,
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
    };

    await service.getReport(USER_ID, base);
    await service.getReport(USER_ID, { ...base, tagIds: ["tag-a"] });
    await service.getReport(USER_ID, { ...base, tagIds: ["tag-b"] });
    await service.getReport(USER_ID, { ...base, tagIds: ["tag-a"] }); // repeat — should hit cache

    expect(repo.getSpendingByCategory).toHaveBeenCalledTimes(3);
  });
});
