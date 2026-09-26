import { describe, expect, it } from "vitest";

import {
  isManualDebtSubtype,
  manualBalanceDeltaCents,
  normalizeManualBalanceCents,
} from "../account-balance.js";

describe("normalizeManualBalanceCents", () => {
  it("passes through positive and negative balances for non-credit subtypes", () => {
    expect(normalizeManualBalanceCents("checking", 500n)).toBe(500n);
    expect(normalizeManualBalanceCents("checking", -500n)).toBe(-500n);
    expect(normalizeManualBalanceCents("cash", 0n)).toBe(0n);
  });

  it("accepts a zero or positive credit-card balance as amount owed", () => {
    expect(normalizeManualBalanceCents("credit_card", 0n)).toBe(0n);
    expect(normalizeManualBalanceCents("credit_card", 12345n)).toBe(12345n);
  });

  it("rejects a negative credit-card balance", () => {
    expect(() => normalizeManualBalanceCents("credit_card", -1n)).toThrow(
      /positive/,
    );
  });
});

describe("isManualDebtSubtype", () => {
  it("flags only credit_card as debt", () => {
    expect(isManualDebtSubtype("credit_card")).toBe(true);
    expect(isManualDebtSubtype("cash")).toBe(false);
    expect(isManualDebtSubtype("checking")).toBe(false);
    expect(isManualDebtSubtype("savings")).toBe(false);
  });
});

describe("manualBalanceDeltaCents", () => {
  it("lowers a money-holding balance on outflow and raises it on inflow", () => {
    expect(manualBalanceDeltaCents("checking", 1250n)).toBe(-1250n);
    expect(manualBalanceDeltaCents("cash", -300n)).toBe(300n);
    expect(manualBalanceDeltaCents("savings", 0n)).toBe(0n);
  });

  it("raises a credit card's amount owed on a purchase and lowers it on a payment", () => {
    expect(manualBalanceDeltaCents("credit_card", 1250n)).toBe(1250n);
    expect(manualBalanceDeltaCents("credit_card", -5000n)).toBe(-5000n);
  });
});
