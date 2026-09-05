import { describe, expect, it } from "vitest";

import { generateForecast } from "../deterministic.js";
import type { ForecastInput } from "../types.js";

function base(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    today: "2026-06-01",
    horizonDays: 3,
    startingBalanceCents: 100_000n,
    events: [],
    discretionaryDailyAvgCents: 5_000n,
    ...overrides,
  };
}

describe("generateForecast", () => {
  it("rejects non-positive horizons", () => {
    expect(() => generateForecast(base({ horizonDays: 0 }))).toThrow(
      "horizonDays must be positive",
    );
  });

  it("returns one day per horizon and advances ISO dates", () => {
    const result = generateForecast(base());
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
  });

  it("subtracts discretionary spend and signed events", () => {
    const result = generateForecast(
      base({
        events: [
          {
            date: "2026-06-01",
            amountCents: 1_700n,
            name: "Netflix",
            confidence: 0.95,
            sourceType: "recurring",
          },
          {
            date: "2026-06-02",
            amountCents: -20_000n,
            name: "Paycheck",
            confidence: 0.99,
            sourceType: "recurring",
          },
        ],
      }),
    );
    expect(result.days.map((day) => day.p50Cents)).toEqual([
      93_300n,
      108_300n,
      103_300n,
    ]);
    expect(result.days.every((day) => day.p10Cents === day.p50Cents)).toBe(
      true,
    );
    expect(result.tightestDay).toEqual({
      date: "2026-06-01",
      balanceCents: 93_300n,
    });
  });

  it("preserves same-day events and permits negative balances", () => {
    const result = generateForecast(
      base({
        startingBalanceCents: 1_000n,
        events: [
          {
            date: "2026-06-01",
            amountCents: 500n,
            name: "A",
            confidence: 0.9,
            sourceType: "manual",
          },
          {
            date: "2026-06-01",
            amountCents: 500n,
            name: "B",
            confidence: 0.9,
            sourceType: "manual",
          },
        ],
      }),
    );
    expect(result.days[0]?.p50Cents).toBe(-5_000n);
    expect(result.days[0]?.events).toHaveLength(2);
  });
});
