import { describe, expect, it } from "vitest";

import {
  derivedCategoryId,
  mergeDuplicateCategories,
  rebalance,
  type SplitLine,
  validateSplitLines,
} from "../split-math.js";

const line = (
  categoryId: string | null,
  amount: bigint,
  position: number,
  isRemainder = false,
): SplitLine => ({ categoryId, amount, position, isRemainder });

const dinner = [line("rest", 10000n, 0), line("owed", 20000n, 1, true)];

describe("derivedCategoryId", () => {
  it("is the largest line's category", () => {
    expect(derivedCategoryId(dinner)).toBe("owed");
  });
  it("compares absolute amounts, so refunds pick the biggest refund", () => {
    expect(
      derivedCategoryId([line("rest", -10000n, 0), line("owed", -20000n, 1)]),
    ).toBe("owed");
  });
  it("breaks ties by the lowest position", () => {
    expect(
      derivedCategoryId([line("owed", 15000n, 1), line("rest", 15000n, 0)]),
    ).toBe("rest");
  });
});

describe("validateSplitLines", () => {
  it("accepts lines that add up with one remainder", () => {
    expect(validateSplitLines(dinner, 30000n)).toBeNull();
  });
  it.each([
    ["too_few_lines", [line("rest", 30000n, 0, true)], 30000n],
    ["zero_line", [line("rest", 0n, 0), line("owed", 30000n, 1, true)], 30000n],
    ["sign_mismatch", [line("rest", -10000n, 0), line("owed", 40000n, 1, true)], 30000n],
    ["sum_mismatch", [line("rest", 10000n, 0), line("owed", 10000n, 1, true)], 30000n],
    ["duplicate_category", [line("rest", 10000n, 0), line("rest", 20000n, 1, true)], 30000n],
    ["duplicate_category", [line(null, 10000n, 0), line(null, 20000n, 1, true)], 30000n],
    ["remainder_count", [line("rest", 10000n, 0), line("owed", 20000n, 1)], 30000n],
    ["remainder_count", [line("rest", 10000n, 0, true), line("owed", 20000n, 1, true)], 30000n],
  ] as const)("returns %s", (error, lines, amount) => {
    expect(validateSplitLines(lines, amount)).toBe(error);
  });
});

describe("rebalance", () => {
  it("lets the remainder absorb a tip", () => {
    const result = rebalance(dinner, 32000n);
    expect(result.outOfBalance).toBe(false);
    expect(result.lines.map((l) => l.amount)).toEqual([10000n, 22000n]);
  });
  it("flags a sign flip and keeps the lines", () => {
    const result = rebalance(dinner, -5000n);
    expect(result.outOfBalance).toBe(true);
    expect(result.lines).toEqual(dinner);
  });
  it("flags a remainder that would reach zero", () => {
    const result = rebalance(dinner, 10000n);
    expect(result.outOfBalance).toBe(true);
    expect(result.lines).toEqual(dinner);
  });
  it("clears the flag when the amount comes back to the lines' total", () => {
    expect(rebalance(dinner, 30000n)).toEqual({ lines: dinner, outOfBalance: false });
  });
});

describe("mergeDuplicateCategories", () => {
  it("sums lines that now share a category into the first, keeping the remainder", () => {
    expect(
      mergeDuplicateCategories([
        line("rest", 10000n, 0),
        line("rest", 5000n, 1, true),
        line("owed", 15000n, 2),
      ]),
    ).toEqual([line("rest", 15000n, 0, true), line("owed", 15000n, 1)]);
  });
});
