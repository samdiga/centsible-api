import { describe, expect, it } from "vitest";
import {
  detectRecurring,
  nextDateForCadence,
  normalizeMerchant,
} from "../recurring-engine.js";

describe("recurring engine", () => {
  it("does not suggest or refresh a regular bill from bank-classified card payments", () => {
    const payments = ["2026-01-15", "2026-02-15", "2026-03-15"].map((date) => ({
      merchantName: "Example card payment",
      name: "Example card payment",
      amountCents: 15000n,
      date,
      isIncome: false,
      isTransfer: false,
      excludeFromBudgets: false,
      plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    }));
    expect(detectRecurring(payments, [])).toEqual({
      toInsert: [],
      toUpdate: [],
    });
    expect(
      detectRecurring(payments, [
        {
          id: "existing",
          canonicalName: "example card payment",
          cadence: "monthly",
          status: "active",
          avgAmountCents: 15000n,
          lastOccurredOn: "2026-01-15",
          nextExpectedDate: "2026-02-15",
        },
      ]),
    ).toEqual({ toInsert: [], toUpdate: [] });
    const mortgage = payments.map((row) => ({
      ...row,
      merchantName: "Mortgage lender",
      plaidCategoryDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
    }));
    expect(detectRecurring(mortgage, []).toInsert).toHaveLength(1);
  });
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

describe("payroll detection", () => {
  const deposits = [-10000n, -25000n, -12000n].map((amountCents, index) => ({
    merchantName: "Employer",
    name: "Payroll",
    amountCents,
    date: ["2026-09-01", "2026-09-15", "2026-09-29"][index]!,
    isIncome: true,
    isTransfer: false,
    excludeFromBudgets: false,
    categoryName: "Paycheck",
  }));
  it("detects variable Paycheck deposits as pending income with a median estimate", () => {
    expect(detectRecurring(deposits, []).toInsert).toEqual([
      expect.objectContaining({
        isIncome: true,
        avgAmountCents: -12000n,
        status: "pending_confirmation",
      }),
    ]);
  });
  it("accepts bank wages without a user income category and excludes refunds and transfers", () => {
    expect(
      detectRecurring(
        deposits.map((row) => ({
          ...row,
          categoryName: null,
          isIncome: false,
          plaidCategoryDetailed: "INCOME_WAGES",
        })),
        [],
      ).toInsert,
    ).toHaveLength(1);
    expect(
      detectRecurring(
        deposits.map((row) => ({
          ...row,
          categoryName: "Refund",
          isIncome: false,
        })),
        [],
      ).toInsert,
    ).toHaveLength(0);
    expect(
      detectRecurring(
        deposits.map((row) => ({ ...row, isTransfer: true })),
        [],
      ).toInsert,
    ).toHaveLength(0);
  });
  it("preserves a user's income dismissal", () => {
    expect(
      detectRecurring(deposits, [
        {
          id: "ended",
          canonicalName: "Employer",
          cadence: "biweekly",
          status: "ended",
          avgAmountCents: -12000n,
          lastOccurredOn: null,
          nextExpectedDate: null,
        },
      ]),
    ).toEqual({ toInsert: [], toUpdate: [] });
  });
});

describe("corrected estimates", () => {
  const payments = ["2026-01-01", "2026-02-01", "2026-03-01"].map((date) => ({
    merchantName: "Utility",
    name: "Utility",
    amountCents: 8000n,
    date,
    isIncome: false,
    isTransfer: false,
    excludeFromBudgets: false,
  }));
  const existing = {
    id: "setup",
    canonicalName: "utility",
    cadence: "monthly",
    cadenceOverride: "weekly" as const,
    status: "active",
    avgAmountCents: 9500n,
    lastOccurredOn: "2026-03-01",
    nextExpectedDate: "2026-04-15",
  };
  it("does not overwrite a correction from the same historical payments", () => {
    expect(detectRecurring(payments, [existing])).toEqual({
      toInsert: [],
      toUpdate: [],
    });
  });
  it("re-estimates from a new payment using the corrected cadence without inserting another series", () => {
    const result = detectRecurring(
      [
        ...payments,
        { ...payments[0]!, date: "2026-04-01", amountCents: 10000n },
      ],
      [existing],
    );
    expect(result.toInsert).toEqual([]);
    expect(result.toUpdate).toEqual([
      expect.objectContaining({
        id: "setup",
        avgAmountCents: 8000n,
        nextExpectedDate: "2026-04-08",
      }),
    ]);
  });
});

it("keeps a corrected series when later evidence changes the detected cadence", () => {
  const payments = ["2026-10-01", "2026-10-08", "2026-10-15"].map((date) => ({
    merchantName: "Utility",
    name: "Utility",
    date,
    amountCents: 8000n,
    isIncome: false,
    isTransfer: false,
    excludeFromBudgets: false,
  }));
  const result = detectRecurring(payments, [
    {
      id: "same",
      canonicalName: "utility",
      cadence: "monthly",
      cadenceOverride: "weekly",
      status: "active",
      avgAmountCents: 9500n,
      lastOccurredOn: "2026-09-01",
      nextExpectedDate: "2026-10-01",
    },
  ]);
  expect(result.toInsert).toEqual([]);
  expect(result.toUpdate).toEqual([
    expect.objectContaining({ id: "same", nextExpectedDate: "2026-10-22" }),
  ]);
});
