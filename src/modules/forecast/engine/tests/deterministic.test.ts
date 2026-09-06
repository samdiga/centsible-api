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

  it("ignores events outside the horizon window", () => {
    const result = generateForecast(
      base({
        events: [
          {
            date: "2026-06-10",
            amountCents: 50_000n,
            name: "Far away",
            confidence: 0.9,
            sourceType: "recurring",
          },
        ],
      }),
    );
    expect(result.days.at(-1)?.p50Cents).toBe(85_000n);
  });

  it("applies every event assigned to a day", () => {
    const result = generateForecast(
      base({
        events: [
          {
            date: "2026-06-01",
            amountCents: 1_000n,
            name: "Netflix",
            confidence: 0.9,
            sourceType: "recurring",
          },
          {
            date: "2026-06-01",
            amountCents: 500n,
            name: "Spotify",
            confidence: 0.9,
            sourceType: "recurring",
          },
        ],
      }),
    );
    expect(result.days[0]?.p50Cents).toBe(93_500n);
    expect(result.days[0]?.events.map((event) => event.name)).toEqual([
      "Netflix",
      "Spotify",
    ]);
  });

  it("keeps the v1 algorithm marker", () => {
    expect(generateForecast(base()).algorithmVersion).toBe("v1");
  });

  it("adds negative signed inflows to the running balance", () => {
    const result = generateForecast(
      base({
        events: [
          {
            date: "2026-06-01",
            amountCents: -200_000n,
            name: "Paycheck",
            confidence: 0.99,
            sourceType: "recurring",
          },
        ],
      }),
    );
    expect(result.days[0]?.p50Cents).toBe(295_000n);
  });

  it("keeps p10 and p90 equal to p50 in v1", () => {
    const result = generateForecast(base());
    for (const day of result.days) {
      expect(day.p10Cents).toBe(day.p50Cents);
      expect(day.p90Cents).toBe(day.p50Cents);
    }
  });

  it("identifies the minimum projected balance as the tightest day", () => {
    const result = generateForecast(base());
    expect(result.tightestDay).toEqual({
      date: "2026-06-03",
      balanceCents: 85_000n,
    });
  });

  it("allows the projected balance to go negative", () => {
    expect(
      generateForecast(base({ startingBalanceCents: 1_000n })).days[0]
        ?.p50Cents,
    ).toBe(-4_000n);
  });

  it("advances across month boundaries without local timezone drift", () => {
    const result = generateForecast(
      base({ today: "2026-01-31", horizonDays: 3 }),
    );
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });
});
