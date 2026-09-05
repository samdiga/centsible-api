import { describe, expect, it } from "vitest";

import { budgetProgress, currentPeriodRange } from "../budget-calculations.js";

describe("budget calculations", () => {
  it("computes category spending and negative remaining amounts", () => {
    const result = budgetProgress(
      [
        { categoryId: "food", amountCents: 50_000n },
        { categoryId: "travel", amountCents: 30_000n },
      ],
      [
        { categoryId: "food", amountCents: 20_000n },
        { categoryId: "food", amountCents: 15_000n },
        { categoryId: "travel", amountCents: 32_000n },
        { categoryId: null, amountCents: 5_000n },
        { categoryId: "food", amountCents: -5_000n },
      ],
    );

    expect(result).toEqual([
      {
        categoryId: "food",
        budgetedCents: 50_000n,
        spentCents: 35_000n,
        remainingCents: 15_000n,
      },
      {
        categoryId: "travel",
        budgetedCents: 30_000n,
        spentCents: 32_000n,
        remainingCents: -2_000n,
      },
    ]);
  });

  it("resolves the monthly period around an anchor day", () => {
    expect(
      currentPeriodRange(
        "2026-01-15",
        "monthly",
        new Date("2026-05-28T12:00:00.000Z"),
      ),
    ).toEqual({ start: "2026-05-15", end: "2026-06-14" });
  });

  it("treats February 28 as the effective day for a 31st anchor", () => {
    expect(
      currentPeriodRange(
        "2026-01-31",
        "monthly",
        new Date("2026-02-28T12:00:00.000Z"),
      ),
    ).toEqual({ start: "2026-02-28", end: "2026-03-30" });
  });

  it("treats leap-day February 29 as the effective day for a 31st anchor", () => {
    expect(
      currentPeriodRange(
        "2028-01-31",
        "monthly",
        new Date("2028-02-29T12:00:00.000Z"),
      ),
    ).toEqual({ start: "2028-02-29", end: "2028-03-30" });
  });
});
