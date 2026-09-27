import { describe, expect, it } from "vitest";
import { calendarForecastRange } from "../forecast-range.js";
import { ForecastQuerySchema } from "../forecast.schemas.js";

describe("calendar forecast ranges", () => {
  it.each([
    [0, "2026-09-30", 4],
    [1, "2026-10-31", 35],
    [3, "2026-12-31", 96],
    [6, "2027-03-31", 186],
  ])("offset %s includes target month end", (offset, endDate, horizonDays) => {
    expect(calendarForecastRange("2026-09-27", offset as number)).toEqual({
      endDate,
      horizonDays,
    });
  });
  it("handles leap years, year boundaries and a one-day current month", () => {
    expect(calendarForecastRange("2024-01-31", 1)).toEqual({
      endDate: "2024-02-29",
      horizonDays: 30,
    });
    expect(calendarForecastRange("2026-12-31", 0)).toEqual({
      endDate: "2026-12-31",
      horizonDays: 1,
    });
    expect(calendarForecastRange("2026-12-31", 1)).toEqual({
      endDate: "2027-01-31",
      horizonDays: 32,
    });
  });
  it("accepts calendar offsets and retains old day-count requests", () => {
    for (const monthOffset of [0, 1, 3, 6])
      expect(
        ForecastQuerySchema.parse({ monthOffset: String(monthOffset) })
          .monthOffset,
      ).toBe(monthOffset);
    for (const horizonDays of [14, 30, 60, 90])
      expect(
        ForecastQuerySchema.parse({ horizonDays: String(horizonDays) })
          .horizonDays,
      ).toBe(horizonDays);
    expect(ForecastQuerySchema.safeParse({ monthOffset: "2" }).success).toBe(
      false,
    );
    expect(ForecastQuerySchema.safeParse({ monthOffset: "-1" }).success).toBe(
      false,
    );
  });
});
