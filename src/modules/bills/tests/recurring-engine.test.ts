import { describe, expect, it } from "vitest";
import {
  detectRecurring,
  nextDateForCadence,
  normalizeMerchant,
} from "../recurring-engine.js";

describe("recurring engine", () => {
  const paycheck = (date: string) => ({
    merchantName: "Example employer payroll",
    name: "Example employer payroll",
    amountCents: -662301n,
    date,
    isIncome: true,
    isTransfer: false,
    excludeFromBudgets: false,
    plaidCategoryDetailed: "INCOME_WAGES",
  });
  // 15th and last business day: Aug 15 2026 is a Saturday, so it paid on the 14th.
  const semimonthlyPay = ["2026-08-14", "2026-08-31", "2026-09-15", "2026-09-30"];

  it("detects semi-monthly pay instead of calling it biweekly", () => {
    const { toInsert } = detectRecurring(semimonthlyPay.map(paycheck), []);
    expect(toInsert).toHaveLength(1);
    expect(toInsert[0]).toMatchObject({
      cadence: "semimonthly",
      nextExpectedDate: "2026-10-15",
      isIncome: true,
    });
  });

  it("keeps refreshing a series the user switched to semi-monthly", () => {
    const { toInsert, toUpdate } = detectRecurring(semimonthlyPay.map(paycheck), [
      {
        id: "payroll",
        canonicalName: "example employer payroll",
        cadence: "biweekly",
        cadenceOverride: "semimonthly",
        status: "active",
        avgAmountCents: -662301n,
        lastOccurredOn: "2026-09-15",
        nextExpectedDate: "2026-09-30",
      },
    ]);
    expect(toInsert).toEqual([]);
    expect(toUpdate).toEqual([
      expect.objectContaining({
        id: "payroll",
        lastOccurredOn: "2026-09-30",
        nextExpectedDate: "2026-10-15",
      }),
    ]);
  });

  it("does not suggest a second series for pay already saved as biweekly", () => {
    expect(
      detectRecurring(semimonthlyPay.map(paycheck), [
        {
          id: "payroll",
          canonicalName: "example employer payroll",
          cadence: "biweekly",
          status: "active",
          avgAmountCents: -662301n,
          lastOccurredOn: "2026-09-15",
          nextExpectedDate: "2026-09-29",
        },
      ]),
    ).toEqual({ toInsert: [], toUpdate: [] });
  });

  it("steps semi-monthly next dates onto the moved pay day", () => {
    expect(nextDateForCadence("2026-10-30", "semimonthly")).toBe("2026-11-13");
  });

  it("does not suggest or refresh a regular bill from payments to linked cards", () => {
    const payments = ["2026-01-15", "2026-02-15", "2026-03-15"].map((date) => ({
      merchantName: "Example card payment",
      name: "Example card payment",
      amountCents: 15000n,
      date,
      isIncome: false,
      isTransfer: false,
      excludeFromBudgets: false,
      plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      paysLinkedCard: true,
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
  describe("payments to cards not linked in Centsy", () => {
    const cardPayment = (date: string, amountCents: bigint) => ({
      merchantName: null,
      name: "CHASE CREDIT CRD DES:EPAY ID:XXXXX CO ID:XXXXX WEB",
      amountCents,
      date,
      isIncome: false,
      isTransfer: false,
      excludeFromBudgets: false,
      plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      paysLinkedCard: false,
    });
    it("suggests a monthly bill from irregular payments in two or more months", () => {
      const { toInsert } = detectRecurring(
        [
          cardPayment("2026-07-03", 5590n),
          cardPayment("2026-08-17", 31043n),
          cardPayment("2026-09-08", 8413n),
        ],
        [],
      );
      expect(toInsert).toEqual([
        expect.objectContaining({
          canonicalName:
            "chase credit crd des epay id xxxxx co id xxxxx web card payment",
          displayName: "Chase Credit Crd card payment",
          cadence: "monthly",
          avgAmountCents: 8413n,
          lastAmountCents: 8413n,
          lastOccurredOn: "2026-09-08",
          nextExpectedDate: "2026-10-08",
          sampleCount: 3,
          status: "pending_confirmation",
          isIncome: false,
        }),
      ]);
    });
    it("needs payments in at least two calendar months", () => {
      expect(
        detectRecurring(
          [cardPayment("2026-09-02", 3886n), cardPayment("2026-09-16", 20194n)],
          [],
        ).toInsert,
      ).toEqual([]);
      expect(
        detectRecurring(
          [
            cardPayment("2026-08-03", 36597n),
            cardPayment("2026-09-02", 25000n),
          ],
          [],
        ).toInsert,
      ).toHaveLength(1);
    });
    it("keeps a store card's payments apart from the store's purchases", () => {
      const purchases = ["2026-07-10", "2026-08-10", "2026-09-10"].map(
        (date) => ({
          merchantName: "Macy's",
          name: "MACYS",
          amountCents: 4000n,
          date,
          isIncome: false,
          isTransfer: false,
          excludeFromBudgets: false,
        }),
      );
      const payments = ["2026-08-03", "2026-09-02"].map((date) => ({
        ...purchases[0]!,
        date,
        amountCents: 25000n,
        plaidCategoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        paysLinkedCard: false,
      }));
      const { toInsert } = detectRecurring([...purchases, ...payments], []);
      expect(
        toInsert.map(({ canonicalName, avgAmountCents, displayName }) => ({
          canonicalName,
          avgAmountCents,
          displayName,
        })),
      ).toEqual([
        {
          canonicalName: "macy s card payment",
          avgAmountCents: 25000n,
          displayName: "Macy's card payment",
        },
        {
          canonicalName: "macy s",
          avgAmountCents: 4000n,
          displayName: undefined,
        },
      ]);
    });
    it("refreshes an active card-payment bill with the latest amount and usual day", () => {
      const existing = {
        id: "existing",
        canonicalName:
          "chase credit crd des epay id xxxxx co id xxxxx web card payment",
        cadence: "monthly",
        status: "active",
        avgAmountCents: 5590n,
        lastOccurredOn: "2026-07-03",
        nextExpectedDate: "2026-08-03",
      };
      const payments = [
        cardPayment("2026-07-03", 5590n),
        cardPayment("2026-08-17", 31043n),
        cardPayment("2026-09-08", 8413n),
      ];
      expect(detectRecurring(payments, [existing])).toEqual({
        toInsert: [],
        toUpdate: [
          {
            id: "existing",
            lastOccurredOn: "2026-09-08",
            nextExpectedDate: "2026-10-08",
            lastAmountCents: 8413n,
            avgAmountCents: 8413n,
            sampleCount: 3,
          },
        ],
      });
      expect(
        detectRecurring(payments, [{ ...existing, status: "ended" }]),
      ).toEqual({ toInsert: [], toUpdate: [] });
    });
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
