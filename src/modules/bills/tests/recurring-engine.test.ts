import { describe, expect, it } from "vitest";
import {
  addDays,
  detectRecurring,
  isSplitSeriesName,
  nextDateForCadence,
  normalizeMerchant,
  splitByAmount,
  splitSeriesSlot,
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
  const semimonthlyPay = [
    "2026-08-14",
    "2026-08-31",
    "2026-09-15",
    "2026-09-30",
  ];

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
    const { toInsert, toUpdate } = detectRecurring(
      semimonthlyPay.map(paycheck),
      [
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
      ],
    );
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

describe("merchants paid on more than one schedule", () => {
  const transfer = (date: string, dollars: number, merchantName: string) => ({
    merchantName,
    name: `${merchantName.toUpperCase()} INVESTMENTS`,
    amountCents: BigInt(dollars * 100),
    date,
    isIncome: false,
    isTransfer: false,
    excludeFromBudgets: false,
    plaidCategoryDetailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
  });
  // Production shape (T-135): every Monday two $50 to Fidelity, every
  // Tuesday $200, all from one checking account, for 13 weeks.
  const fidelityWeeks = Array.from({ length: 13 }, (_, week) => {
    const monday = addDays("2026-07-06", week * 7);
    return [
      transfer(monday, 50, "Fidelity"),
      transfer(monday, 50, "Fidelity"),
      transfer(addDays(monday, 1), 200, "Fidelity"),
    ];
  }).flat();

  it("suggests one weekly bill per amount, and one per same-day repeat", () => {
    const { toInsert } = detectRecurring(fidelityWeeks, []);
    expect(
      toInsert
        .map((row) => [
          row.canonicalName,
          row.displayName,
          row.cadence,
          row.avgAmountCents,
        ])
        .sort(),
    ).toEqual(
      [
        ["fidelity $200", "Fidelity $200", "weekly", 20000n],
        ["fidelity $50 1/2", "Fidelity $50 (1 of 2)", "weekly", 5000n],
        ["fidelity $50 2/2", "Fidelity $50 (2 of 2)", "weekly", 5000n],
      ].sort(),
    );
    const tuesday = toInsert.find(
      (row) => row.canonicalName === "fidelity $200",
    )!;
    expect(tuesday).toMatchObject({
      lastOccurredOn: "2026-09-29",
      nextExpectedDate: "2026-10-06",
      sampleCount: 13,
    });
  });

  it("keeps a merchant on one schedule as one bill, one-off payments and all", () => {
    const robinhood = Array.from({ length: 13 }, (_, week) =>
      transfer(addDays("2026-07-07", week * 7), 200, "Robinhood"),
    );
    const { toInsert } = detectRecurring(
      [
        ...robinhood,
        transfer("2026-07-29", 500, "Robinhood"),
        transfer("2026-08-10", 200, "Robinhood"),
      ],
      [],
    );
    expect(toInsert.map((row) => row.canonicalName)).toEqual(["robinhood"]);
  });

  it("does not suggest a split bill that the merchant's own bill already covers", () => {
    const messy = [
      ...Array.from({ length: 6 }, (_, week) =>
        transfer(addDays("2026-08-04", week * 7), 200, "Robinhood"),
      ),
      ...[
        "2026-08-05",
        "2026-08-06",
        "2026-08-12",
        "2026-08-13",
        "2026-08-20",
      ].map((date) => transfer(date, 35, "Robinhood")),
    ];
    const existing = [
      {
        id: "bill-1",
        canonicalName: "robinhood",
        cadence: "weekly",
        status: "active",
        avgAmountCents: 20000n,
        lastOccurredOn: "2026-08-04",
        nextExpectedDate: "2026-08-11",
      },
    ];
    // Without that bill the split is suggested, so the guard is what stops it.
    expect(
      detectRecurring(messy, []).toInsert.map((row) => row.canonicalName),
    ).toContain("robinhood $200");
    const { toInsert } = detectRecurring(messy, existing);
    expect(toInsert.map((row) => row.canonicalName)).not.toContain(
      "robinhood $200",
    );
  });

  it("recognises split and slot names", () => {
    expect(isSplitSeriesName("fidelity $200")).toBe(true);
    expect(isSplitSeriesName("fidelity $50 1/2")).toBe(true);
    expect(isSplitSeriesName("fidelity")).toBe(false);
    expect(isSplitSeriesName("Rent")).toBe(false);
    expect(splitSeriesSlot("fidelity $50 2/2")).toEqual({
      base: "fidelity $50",
      slot: 2,
      of: 2,
    });
    expect(splitSeriesSlot("fidelity $200")).toBeNull();
    expect(
      splitByAmount("acme", [transfer("2026-08-01", 12.5, "Acme")])[0],
    ).toMatchObject({
      canonicalName: "acme $12.50",
      displayName: "Acme $12.50",
    });
  });
});
