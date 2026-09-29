import { describe, expect, it } from "vitest";

import {
  budgetProgress,
  budgetUsageEntries,
  currentPeriodRange,
  monthRange,
} from "../budget-calculations.js";

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

describe("monthRange", () => {
  it("covers the calendar month, first to last day", () => {
    expect(monthRange("2026-10")).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
    });
    expect(monthRange("2028-02")).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
    expect(monthRange("2026-02").end).toBe("2026-02-28");
  });
});

describe("budgetUsageEntries", () => {
  const parents = new Map<string, string | null>([
    ["food", null],
    ["dining", "food"],
    ["gym", null],
  ]);

  it("lists each category's own plan and spend, not rolled up", () => {
    expect(
      budgetUsageEntries({
        items: [
          { categoryId: "food", amountCents: 50000n, isPaused: false },
          { categoryId: "dining", amountCents: 20000n, isPaused: false },
        ],
        spent: [
          { categoryId: "dining", spentCents: 12000n },
          { categoryId: "gym", spentCents: -500n },
        ],
        parents,
      }),
    ).toEqual([
      {
        categoryId: "dining",
        parentId: "food",
        plannedCents: 20000n,
        spentCents: 12000n,
      },
      {
        categoryId: "food",
        parentId: null,
        plannedCents: 50000n,
        spentCents: 0n,
      },
      {
        categoryId: "gym",
        parentId: null,
        plannedCents: null,
        spentCents: -500n,
      },
    ]);
  });

  it("gives paused items no plan and drops categories with nothing to show", () => {
    expect(
      budgetUsageEntries({
        items: [
          { categoryId: "gym", amountCents: 4000n, isPaused: true },
          { categoryId: "food", amountCents: 50000n, isPaused: true },
        ],
        spent: [
          { categoryId: "food", spentCents: 3000n },
          { categoryId: "dining", spentCents: 0n },
        ],
        parents,
      }),
    ).toEqual([
      {
        categoryId: "food",
        parentId: null,
        plannedCents: null,
        spentCents: 3000n,
      },
    ]);
  });

  it("has no plan at all without a budget for the month", () => {
    expect(
      budgetUsageEntries({
        items: null,
        spent: [{ categoryId: "food", spentCents: 3000n }],
        parents,
      }),
    ).toEqual([
      {
        categoryId: "food",
        parentId: null,
        plannedCents: null,
        spentCents: 3000n,
      },
    ]);
  });
});
