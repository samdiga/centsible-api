import { describe, expect, it, vi } from "vitest";

import { createResponseCache } from "../../../platform/cache/response-cache.js";
import { createForecastService } from "../forecast.service.js";
import type { ForecastResult } from "../engine/types.js";

const forecast: ForecastResult = {
  days: [],
  tightestDay: { date: "2026-06-01", balanceCents: 0n },
  algorithmVersion: "v1",
};
const forecastResponse = {
  days: [],
  tightestDay: { date: "2026-06-01", balanceCents: "0" },
  algorithmVersion: "v1" as const,
  horizonDays: 30,
};

function deps() {
  return {
    repository: {
      getForecastInputs: vi.fn().mockResolvedValue({
        startingBalanceCents: 100n,
        events: [],
        discretionaryDailyAvgCents: 2n,
      }),
      saveForecastRun: vi.fn().mockResolvedValue("run-1"),
      getAccuracySummary: vi
        .fn()
        .mockResolvedValue({ mape30d: null, runCount: 0 }),
      computeAndSaveAccuracyBatch: vi.fn().mockResolvedValue(0),
      isFeatureEnabled: vi
        .fn()
        .mockImplementation(async (key: string) => key === "cash_horizon_v1"),
    },
    cache: { getOrCompute: vi.fn((_key, compute) => compute()) },
    getUserRevision: vi.fn().mockResolvedValue(4n),
    now: () => new Date("2026-06-01T04:00:00.000Z"),
    timezone: "America/New_York",
    generate: vi.fn().mockReturnValue(forecast),
    logger: { error: vi.fn() },
  };
}

describe("forecast service", () => {
  it("includes date, timezone, revision, horizon, and algorithm in cache identity", async () => {
    const dependencies = deps();
    const service = createForecastService(dependencies);
    await service.getForecast("user-1", 30);
    const key = dependencies.cache.getOrCompute.mock.calls[0]?.[0];
    expect(key).toMatchObject({
      userId: "user-1",
      route: "/forecast",
      revision: 4n,
      algorithmVersion: "v1",
      horizon: "30",
      date: "2026-06-01",
      timezone: "America/New_York",
    });
  });

  it("checks the feature before generating", async () => {
    const dependencies = deps();
    dependencies.repository.isFeatureEnabled.mockResolvedValue(false);
    const service = createForecastService(dependencies);
    await expect(service.getForecast("user-1", 30)).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
      httpStatus: 403,
    });
    expect(dependencies.generate).not.toHaveBeenCalled();
  });

  it("catches persistence failures without delaying the response", async () => {
    const dependencies = deps();
    dependencies.repository.saveForecastRun.mockRejectedValue(
      new Error("write failed"),
    );
    const service = createForecastService(dependencies);
    await expect(service.getForecast("user-1", 30)).resolves.toEqual(
      forecastResponse,
    );
    await vi.waitFor(() =>
      expect(dependencies.logger.error).toHaveBeenCalled(),
    );
  });

  it("caches a JSON-safe response and schedules generation and persistence once", async () => {
    const dependencies = deps();
    const generate = vi.fn().mockReturnValue({
      ...forecast,
      days: [
        {
          date: "2026-06-01",
          p50Cents: 100n,
          p10Cents: 100n,
          p90Cents: 100n,
          events: [],
        },
      ],
    });
    const service = createForecastService({
      ...dependencies,
      cache: createResponseCache(),
      generate,
    });

    const first = await service.getForecast("user-1", 30);
    const second = await service.getForecast("user-1", 30);

    expect(first).toEqual(second);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(dependencies.repository.saveForecastRun).toHaveBeenCalledTimes(1);
    expect(first.days[0]?.p50Cents).toBe("100");
  });
});

it("isolates v2 cache identity and returns JSON-safe account fields only on opt-in", async () => {
  const dependencies = deps();
  dependencies.repository.isFeatureEnabled.mockResolvedValue(true);
  const getAccountInputs = vi.fn().mockResolvedValue({
    accounts: [
      { id: "cash", name: "Cash", kind: "cash", startingBalanceCents: 100n },
    ],
    events: [],
    dailySpendByAccount: new Map(),
    unassignedBillCount: 0,
  });
  const service = createForecastService({ ...dependencies, getAccountInputs });
  const response = await service.getForecast("user-1", 30);
  expect(response.algorithmVersion).toBe("v2");
  expect(response.accounts?.[0]?.balances).toHaveLength(30);
  expect(response.accounts?.[0]?.balances[0]).toBe("100");
  expect(dependencies.repository.getForecastInputs).not.toHaveBeenCalled();
  expect(dependencies.generate).not.toHaveBeenCalled();
  expect(dependencies.cache.getOrCompute.mock.calls[0]?.[0]).toMatchObject({
    algorithmVersion: "v2",
  });
  expect(() => JSON.stringify(response)).not.toThrow();
});

it("calendar ranges use server timezone, actual days and end-date cache identity", async () => {
  const dependencies = deps();
  dependencies.now = () => new Date("2026-09-28T01:00:00Z"); // Sep 27 in New York
  const service = createForecastService(dependencies);
  const result = await service.getForecast("user-1", 30, 6);
  expect(result.horizonDays).toBe(186);
  expect(dependencies.repository.getForecastInputs).toHaveBeenCalledWith(
    "user-1",
    186,
    "2026-09-27",
  );
  expect(dependencies.cache.getOrCompute.mock.calls[0]?.[0]).toMatchObject({
    date: "2026-09-27",
    query: { monthOffset: ["6"], endDate: ["2027-03-31"] },
    horizon: "186",
  });
});
