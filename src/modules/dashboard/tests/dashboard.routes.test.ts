import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import { createResponseCache } from "../../../platform/cache/response-cache.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import { createDashboardService } from "../dashboard.service.js";
import type { DashboardRepository } from "../dashboard.repository.js";
import type { DashboardService } from "../dashboard.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const service: DashboardService = {
  getSummary: vi.fn(async () => ({
    netWorth: "250000",
    assets: "300000",
    liabilities: "50000",
    safeToSpend: "290000",
    safeToSpendHasBills: false,
    spendingThisMonth: "0",
    spendingLastMonth: "0",
    upcomingBills: [],
  })),
  getNetWorthHistory: vi.fn(async () => ({ points: [] })),
};

describe("dashboard routes", () => {
  it("returns the bigint-safe dashboard summary wire shape", async () => {
    const response = await createHttpApp({
      auth,
      dashboardService: service,
    }).request("/dashboard/summary", {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary).toMatchObject({
      netWorth: expect.stringMatching(/^-?\d+$/),
      safeToSpend: expect.stringMatching(/^-?\d+$/),
      upcomingBills: expect.any(Array),
    });
  });

  it("requires authentication", async () => {
    const response = await createHttpApp({ dashboardService: service }).request(
      "/dashboard/summary",
    );

    expect(response.status).toBe(401);
  });

  it("separates cached summaries when the user revision or UTC date changes", async () => {
    let revision = 1n;
    let now = new Date("2026-05-31T23:59:59.000Z");
    const repository: DashboardRepository = {
      listAccounts: vi.fn(async () => []),
      getSpendingTotals: vi.fn(async () => ({ thisMonth: 0n, lastMonth: 0n })),
      getUpcomingBills: vi.fn(async () => []),
      getNetWorthHistory: vi.fn(async () => []),
    };
    const service = createDashboardService({
      repository,
      cache: createResponseCache(),
      getUserRevision: async () => revision,
      now: () => now,
    });

    await service.getSummary(USER_ID);
    await service.getSummary(USER_ID);
    revision = 2n;
    await service.getSummary(USER_ID);
    now = new Date("2026-06-01T00:00:00.000Z");
    await service.getSummary(USER_ID);

    expect(repository.listAccounts).toHaveBeenCalledTimes(3);
    expect(repository.getSpendingTotals).toHaveBeenCalledTimes(3);
    expect(repository.getUpcomingBills).toHaveBeenCalledTimes(3);
  });

  it("separates cached net worth history responses by dateFrom/dateTo/resolution", async () => {
    const repository: DashboardRepository = {
      listAccounts: vi.fn(async () => []),
      getSpendingTotals: vi.fn(async () => ({ thisMonth: 0n, lastMonth: 0n })),
      getUpcomingBills: vi.fn(async () => []),
      getNetWorthHistory: vi.fn(async () => []),
    };
    const service = createDashboardService({
      repository,
      cache: createResponseCache(),
      getUserRevision: async () => 1n,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });
    const base = { dateFrom: "2026-08-01", dateTo: "2026-08-15" } as const;

    await service.getNetWorthHistory(USER_ID, base.dateFrom, base.dateTo, "daily");
    await service.getNetWorthHistory(USER_ID, base.dateFrom, base.dateTo, "daily"); // repeat — cache hit
    await service.getNetWorthHistory(USER_ID, base.dateFrom, base.dateTo, "weekly"); // different resolution
    await service.getNetWorthHistory(USER_ID, "2026-07-01", base.dateTo, "daily"); // different dateFrom

    // 3, not 4 or 1 — proves resolution and dateFrom both changed the cache
    // key (the exact bug class the Reports fix wave caught for a missing
    // tagIds dimension), and the exact repeat call was actually cached.
    expect(repository.getNetWorthHistory).toHaveBeenCalledTimes(3);
  });

  it("serializes NetWorthHistoryPointRow bigints to the wire's cents-string shape", async () => {
    const repository: DashboardRepository = {
      listAccounts: vi.fn(async () => []),
      getSpendingTotals: vi.fn(async () => ({ thisMonth: 0n, lastMonth: 0n })),
      getUpcomingBills: vi.fn(async () => []),
      getNetWorthHistory: vi.fn(async () => [
        {
          date: "2026-08-01",
          netWorthCents: 80000n,
          assetsCents: 100000n,
          liabilitiesCents: 20000n,
        },
      ]),
    };
    const service = createDashboardService({
      repository,
      getUserRevision: async () => 1n,
    });

    const result = await service.getNetWorthHistory(
      USER_ID,
      "2026-08-01",
      "2026-08-31",
      "daily",
    );

    expect(result).toEqual({
      points: [
        {
          date: "2026-08-01",
          netWorthCents: "80000",
          assetsCents: "100000",
          liabilitiesCents: "20000",
        },
      ],
    });
  });

  it("starts independent dashboard repository reads before awaiting any result", async () => {
    let resolveAccounts: (() => void) | undefined;
    let resolveTotals: (() => void) | undefined;
    let resolveBills: (() => void) | undefined;
    const accountsGate = new Promise<void>((resolve) => {
      resolveAccounts = resolve;
    });
    const totalsGate = new Promise<void>((resolve) => {
      resolveTotals = resolve;
    });
    const billsGate = new Promise<void>((resolve) => {
      resolveBills = resolve;
    });
    const started: string[] = [];
    const repository: DashboardRepository = {
      listAccounts: vi.fn(async () => {
        started.push("accounts");
        await accountsGate;
        return [];
      }),
      getSpendingTotals: vi.fn(async () => {
        started.push("totals");
        await totalsGate;
        return { thisMonth: 0n, lastMonth: 0n };
      }),
      getUpcomingBills: vi.fn(async () => {
        started.push("bills");
        await billsGate;
        return [];
      }),
      getNetWorthHistory: vi.fn(async () => []),
    };
    const service = createDashboardService({
      repository,
      getUserRevision: async () => 1n,
    });

    const summary = service.getSummary(USER_ID);
    await Promise.resolve();
    await Promise.resolve();
    expect(started.sort()).toEqual(["accounts", "bills", "totals"]);
    resolveAccounts?.();
    resolveTotals?.();
    resolveBills?.();
    await expect(summary).resolves.toMatchObject({ netWorth: "0" });
  });

  it("returns the wire shape for a valid history request", async () => {
    const dashboardService: DashboardService = {
      getSummary: vi.fn(async () => ({
        netWorth: "0", assets: "0", liabilities: "0", safeToSpend: "0",
        safeToSpendHasBills: false, spendingThisMonth: "0", spendingLastMonth: "0",
        upcomingBills: [],
      })),
      getNetWorthHistory: vi.fn(async () => ({
        points: [
          { date: "2026-08-01", netWorthCents: "80000", assetsCents: "100000", liabilitiesCents: "20000" },
        ],
      })),
    };
    const response = await createHttpApp({ auth, dashboardService }).request(
      "/dashboard/net-worth/history?dateFrom=2026-08-01&dateTo=2026-08-31&resolution=daily",
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      points: [
        { date: "2026-08-01", netWorthCents: "80000", assetsCents: "100000", liabilitiesCents: "20000" },
      ],
    });
    expect(dashboardService.getNetWorthHistory).toHaveBeenCalledWith(
      USER_ID, "2026-08-01", "2026-08-31", "daily",
    );
  });

  it("rejects a request with a missing resolution", async () => {
    const dashboardService: DashboardService = {
      getSummary: vi.fn(),
      getNetWorthHistory: vi.fn(),
    };
    const response = await createHttpApp({ auth, dashboardService }).request(
      "/dashboard/net-worth/history?dateFrom=2026-08-01&dateTo=2026-08-31",
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(400);
    expect(dashboardService.getNetWorthHistory).not.toHaveBeenCalled();
  });

  it("rejects dateTo before dateFrom", async () => {
    const dashboardService: DashboardService = {
      getSummary: vi.fn(),
      getNetWorthHistory: vi.fn(),
    };
    const response = await createHttpApp({ auth, dashboardService }).request(
      "/dashboard/net-worth/history?dateFrom=2026-08-31&dateTo=2026-08-01&resolution=daily",
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(400);
    expect(dashboardService.getNetWorthHistory).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const dashboardService: DashboardService = {
      getSummary: vi.fn(),
      getNetWorthHistory: vi.fn(),
    };
    const response = await createHttpApp({ dashboardService }).request(
      "/dashboard/net-worth/history?dateFrom=2026-08-01&dateTo=2026-08-31&resolution=daily",
    );

    expect(response.status).toBe(401);
  });
});
