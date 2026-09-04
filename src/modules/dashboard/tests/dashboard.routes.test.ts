import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
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
});
