import { describe, expect, it, vi } from "vitest";

import { createForecastService } from "../forecast.service.js";
import type { ForecastResult } from "../engine/types.js";

const forecast: ForecastResult = {
  days: [],
  tightestDay: { date: "2026-06-01", balanceCents: 0n },
  algorithmVersion: "v1",
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
      isFeatureEnabled: vi.fn().mockResolvedValue(true),
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
    await expect(service.getForecast("user-1", 30)).resolves.toBe(forecast);
    await vi.waitFor(() =>
      expect(dependencies.logger.error).toHaveBeenCalled(),
    );
  });
});
