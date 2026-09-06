import { describe, expect, it } from "vitest";

import { forecastScoringWindow } from "../forecast.repository.js";

describe("forecast accuracy scoring window", () => {
  it("uses the first and last persisted forecast dates", () => {
    expect(
      forecastScoringWindow(
        [{ date: "2026-06-02" }, { date: "2026-06-15" }],
        new Date("2026-06-01T23:00:00.000Z"),
        30,
      ),
    ).toEqual({ startDate: "2026-06-02", endDate: "2026-06-15" });
  });

  it("falls back to the persisted run creation date for empty legacy runs", () => {
    expect(
      forecastScoringWindow([], new Date("2026-06-01T23:00:00.000Z"), 14),
    ).toEqual({ startDate: "2026-06-01", endDate: "2026-06-15" });
  });
});
