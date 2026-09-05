import { describe, expect, it } from "vitest";
import {
  detectRecurring,
  nextDateForCadence,
  normalizeMerchant,
} from "../recurring-engine.js";

describe("recurring engine", () => {
  it("normalizes merchant identifiers and detects confirmed monthly candidates", () => {
    expect(normalizeMerchant("Netflix Inc #123")).toBe("netflix");
    const result = detectRecurring(
      ["2026-01-31", "2026-02-28", "2026-03-31"].map((date) => ({
        merchantName: "Netflix Inc",
        name: "NETFLIX",
        amountCents: 1599n,
        date,
        isIncome: false,
        isTransfer: false,
        excludeFromBudgets: false,
      })),
      [],
    );
    expect(result.toInsert).toEqual([
      expect.objectContaining({
        canonicalName: "netflix",
        cadence: "monthly",
        nextExpectedDate: "2026-04-30",
        status: "pending_confirmation",
      }),
    ]);
  });

  it("clamps calendar cadence dates at the target month boundary", () => {
    expect(nextDateForCadence("2026-01-31", "monthly")).toBe("2026-02-28");
  });

  it("advances daily cadence one UTC day at a time", () => {
    expect(nextDateForCadence("2026-02-28", "daily")).toBe("2026-03-01");
  });
});
