import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../../../app/create-http-app.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import type { ReportsService } from "../reports.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const query = "?type=income_vs_spending&dateFrom=2026-05-01&dateTo=2026-05-31";

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

function service(result?: unknown): ReportsService {
  return {
    getReport: vi.fn(
      async () =>
        result ?? {
          type: "income_vs_spending",
          months: [
            {
              month: "2026-05",
              incomeCents: "400000",
              spendingCents: "100000",
            },
          ],
        },
    ) as unknown as ReportsService["getReport"],
  };
}

describe("reports routes", () => {
  it("requires authentication", async () => {
    const response = await createHttpApp({
      reportsService: service(),
    }).request(`/reports/summary${query}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
      requestId: expect.any(String),
    });
  });

  it("validates the query and returns the unified validation envelope", async () => {
    const reportsService = service();
    const response = await createHttpApp({ auth, reportsService }).request(
      "/reports/summary?type=income_vs_spending&dateFrom=bad&dateTo=2026-05-31",
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION", message: "Invalid request" },
      requestId: expect.any(String),
    });
    expect(reportsService.getReport).not.toHaveBeenCalled();
  });

  it("returns the validated representative report wire shape", async () => {
    const reportsService = service();
    const response = await createHttpApp({ auth, reportsService }).request(
      `/reports/summary${query}`,
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: "income_vs_spending",
      months: [
        {
          month: "2026-05",
          incomeCents: "400000",
          spendingCents: "100000",
        },
      ],
    });
    expect(reportsService.getReport).toHaveBeenCalledWith(USER_ID, {
      type: "income_vs_spending",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
    });
  });

  it("maps invalid service output to the unified internal envelope", async () => {
    const response = await createHttpApp({
      auth,
      reportsService: service({
        type: "monthly_spending",
        months: [{ month: "2026-05", totalCents: 42 }],
      }),
    }).request(`/reports/summary${query}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL", message: "Something went wrong." },
      requestId: expect.any(String),
    });
  });
});
