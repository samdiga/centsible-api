import { describe, expect, it } from "vitest";

import { applyAddExpenses, applySkipScenarios } from "../scenario.js";
import type { ForecastDay } from "../types.js";

function day(
  date: string,
  p50Cents: string,
  events: ForecastDay["events"] = [],
): ForecastDay {
  return { date, p50Cents, p10Cents: p50Cents, p90Cents: p50Cents, events };
}

function event(
  name: string,
  amountCents: string,
  recurringSeriesId: string | null,
): ForecastDay["events"][number] {
  return {
    name,
    amountCents,
    confidence: 0.9,
    sourceType: "recurring",
    recurringSeriesId,
  };
}

describe("forecast scenarios", () => {
  it("returns the same array when no series are skipped", () => {
    const days = [day("2026-06-01", "100000")];
    expect(applySkipScenarios(days, new Set())).toBe(days);
  });

  it("returns the same array when no expenses are added", () => {
    const days = [day("2026-06-01", "100000")];
    expect(applyAddExpenses(days, [])).toBe(days);
  });

  it("removes skipped events and cascades the recovered balance", () => {
    const days = [
      day("2026-06-01", "100000", [event("Rent", "1500", "series-1")]),
      day("2026-06-02", "98500"),
    ];
    const result = applySkipScenarios(days, new Set(["series-1"]));
    expect(result[0]).toMatchObject({ p50Cents: "101500", events: [] });
    expect(result[1]?.p50Cents).toBe("100000");
    expect(days[0]?.p50Cents).toBe("100000");
  });

  it("injects added expenses and cascades their cost", () => {
    const days = [day("2026-06-01", "100000"), day("2026-06-02", "95000")];
    const result = applyAddExpenses(days, [
      {
        id: "expense-1",
        name: "Concert",
        amountCents: 5_000n,
        date: "2026-06-01",
      },
    ]);
    expect(result[0]).toMatchObject({ p50Cents: "95000" });
    expect(result[0]?.events[0]).toMatchObject({
      name: "Concert",
      amountCents: "5000",
      sourceType: "manual",
    });
    expect(result[1]?.p50Cents).toBe("90000");
  });

  it("skips multiple series independently and ignores null series IDs", () => {
    const days = [
      day("2026-06-01", "100000", [
        event("Netflix", "1500", "series-1"),
        event("Spotify", "1000", "series-2"),
        event("Manual", "500", null),
      ]),
      day("2026-06-02", "97500"),
    ];
    const result = applySkipScenarios(days, new Set(["series-1", "series-2"]));
    expect(result[0]?.p50Cents).toBe("102500");
    expect(result[0]?.events).toHaveLength(1);
    expect(result[1]?.p50Cents).toBe("100000");
  });

  it("cascades multiple skipped occurrences of the same series", () => {
    const days = [
      day("2026-06-01", "100000", [event("Rent", "1500", "series-1")]),
      day("2026-06-08", "98500", [event("Rent", "1500", "series-1")]),
      day("2026-06-15", "97000"),
    ];
    const result = applySkipScenarios(days, new Set(["series-1"]));
    expect(result.map((entry) => entry.p50Cents)).toEqual([
      "101500",
      "101500",
      "100000",
    ]);
  });

  it("ignores expenses outside the forecast horizon and does not mutate input", () => {
    const days = [day("2026-06-01", "100000")];
    const result = applyAddExpenses(days, [
      {
        id: "outside",
        name: "Outside",
        amountCents: 5_000n,
        date: "2026-07-01",
      },
    ]);
    expect(result[0]?.p50Cents).toBe("100000");
    expect(result[0]?.events).toHaveLength(0);
    expect(days[0]?.p50Cents).toBe("100000");
  });

  it("handles two skipped series on one day", () => {
    const days = [
      day("2026-06-01", "100000", [
        event("A", "1500", "series-1"),
        event("B", "1000", "series-2"),
      ]),
      day("2026-06-02", "97500"),
    ];
    const result = applySkipScenarios(days, new Set(["series-1", "series-2"]));
    expect(result[0]?.p50Cents).toBe("102500");
    expect(result[0]?.events).toHaveLength(0);
    expect(result[1]?.p50Cents).toBe("100000");
  });

  it("adds multiple expenses on one day", () => {
    const days = [day("2026-06-01", "100000")];
    const result = applyAddExpenses(days, [
      { id: "a", name: "A", amountCents: 1_000n, date: "2026-06-01" },
      { id: "b", name: "B", amountCents: 2_000n, date: "2026-06-01" },
    ]);
    expect(result[0]?.p50Cents).toBe("97000");
    expect(result[0]?.events).toHaveLength(2);
  });
});
