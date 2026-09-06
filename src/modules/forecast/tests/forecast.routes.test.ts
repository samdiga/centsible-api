import { describe, expect, it } from "vitest";

import { createHttpApp } from "../../../app/create-http-app.js";
import { FeatureDisabledError } from "../../../platform/errors/app-error.js";
import type { ForecastService } from "../forecast.service.js";

const auth = async (
  c: { set: (key: "userId", value: string) => void },
  next: () => Promise<void>,
) => {
  c.set("userId", "user-1");
  await next();
};

const result = {
  days: [
    {
      date: "2026-06-01",
      p50Cents: "100000",
      p10Cents: "90000",
      p90Cents: "110000",
      events: [
        {
          date: "2026-06-01",
          amountCents: "1500",
          name: "Rent",
          confidence: 0.9,
          sourceType: "recurring" as const,
          sourceId: "event-1",
          recurringSeriesId: "00000000-0000-4000-8000-000000000001",
        },
        {
          date: "2026-06-01",
          amountCents: "-500",
          name: "Pending",
          confidence: 0.7,
          sourceType: "pending_transaction" as const,
          sourceId: "pending-1",
          recurringSeriesId: null,
        },
      ],
    },
  ],
  tightestDay: { date: "2026-06-01", balanceCents: "100000" },
  algorithmVersion: "v1" as const,
  horizonDays: 30,
};

function service(overrides: Partial<ForecastService> = {}): ForecastService {
  return {
    getForecast: async () => result,
    getAccuracy: async () => ({ mape30d: 0.08, runCount: 5 }),
    ...overrides,
  };
}

describe("Forecast routes", () => {
  it("rejects unsupported horizons with the shared validation envelope", async () => {
    const app = createHttpApp({ auth, forecastService: service() });
    const response = await app.request("/forecast?horizonDays=15");
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("serializes all money values as signed decimal strings", async () => {
    const app = createHttpApp({ auth, forecastService: service() });
    const response = await app.request("/forecast?horizonDays=30");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      days: Array<{
        p50Cents: string;
        p10Cents: string;
        events: Array<{
          amountCents: string;
          recurringSeriesId?: string | null;
        }>;
      }>;
      tightestDay: { balanceCents: string };
    };
    const firstDay = body.days[0]!;
    expect(firstDay.p50Cents).toBe("100000");
    expect(firstDay.p10Cents).toBe("90000");
    expect(firstDay.events[0]!.amountCents).toBe("1500");
    expect(firstDay.events[1]!.recurringSeriesId).toBeNull();
    expect(body.tightestDay.balanceCents).toBe("100000");
  });

  it("maps a disabled feature to the stable 403 error envelope", async () => {
    const app = createHttpApp({
      auth,
      forecastService: service({
        getForecast: async () => {
          throw new FeatureDisabledError("Cash Horizon is not available yet.");
        },
      }),
    });
    const response = await app.request("/forecast?horizonDays=30");
    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: "FEATURE_DISABLED" },
    });
  });

  it("passes all supported horizon values to the service", async () => {
    const horizons: number[] = [];
    const app = createHttpApp({
      auth,
      forecastService: service({
        getForecast: async (_userId, horizon) => {
          horizons.push(horizon);
          return { ...result, horizonDays: horizon };
        },
      }),
    });
    for (const horizon of [14, 30, 60, 90]) {
      expect(
        (await app.request(`/forecast?horizonDays=${horizon}`)).status,
      ).toBe(200);
    }
    expect(horizons).toEqual([14, 30, 60, 90]);
  });

  it("returns forecast accuracy", async () => {
    const app = createHttpApp({ auth, forecastService: service() });
    const response = await app.request("/forecast/accuracy");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mape30d: 0.08, runCount: 5 });
  });

  it("returns null accuracy until three completed runs exist", async () => {
    const app = createHttpApp({
      auth,
      forecastService: service({
        getAccuracy: async () => ({ mape30d: null, runCount: 1 }),
      }),
    });
    const response = await app.request("/forecast/accuracy");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mape30d: null, runCount: 1 });
  });
});
