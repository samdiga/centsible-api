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
});
