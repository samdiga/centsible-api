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
});
