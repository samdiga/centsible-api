import { describe, expect, it } from "vitest";

import type { AccountWithItem } from "../accounts.repository.js";
import { toAccountSummary } from "../accounts.mapper.js";

const base = {
  id: "22222222-2222-4222-8222-222222222222",
  userId: "11111111-1111-4111-8111-111111111111",
  plaidItemId: "33333333-3333-4333-8333-333333333333",
  plaidAccountId: "pa",
  name: "Platinum Card®",
  officialName: null,
  type: "credit",
  subtype: "credit_card",
  mask: "1001",
  currency: "USD",
  currentBalance: 12000n,
  availableBalance: null,
  limit: 500000n,
  paymentDueDate: "2026-10-06",
  statementBalance: null,
  statementDate: null,
  minimumPayment: null,
  apr: null,
  apy: null,
  apyOverride: null,
  subtypeOverride: null,
  color: null,
  icon: null,
  isHidden: false,
  isManual: false,
  archivedAt: null,
  balanceLastRefreshedAt: null,
  nameOverride: null,
  limitOverride: null,
  paymentDueDateOverride: null,
  plaidItem: {
    id: "33333333-3333-4333-8333-333333333333",
    status: "active",
    errorCode: null,
    institutionId: "ins_10",
    institutionName: "American Express",
  },
} as unknown as AccountWithItem;

describe("account summary bank values", () => {
  it("shows the merged value and, separately, what the bank reports", () => {
    const summary = toAccountSummary({
      ...base,
      nameOverride: "Travel card",
      limitOverride: 800000n,
    } as AccountWithItem);
    expect(summary.name).toBe("Travel card");
    expect(summary.limit).toBe("800000");
    expect(summary.paymentDueDate).toBe("2026-10-06");
    expect(summary.bank).toEqual({
      name: "Platinum Card®",
      limit: "500000",
      paymentDueDate: "2026-10-06",
      subtype: "credit_card",
      apy: null,
    });
    expect(summary.overridden).toEqual({
      name: true,
      limit: true,
      paymentDueDate: false,
      subtype: false,
      apy: false,
    });
  });

  it("has no bank values for a manual account", () => {
    const summary = toAccountSummary({
      ...base,
      isManual: true,
      plaidItem: null,
    } as AccountWithItem);
    expect(summary.bank).toBeNull();
    expect(summary.overridden).toEqual({
      name: false,
      limit: false,
      paymentDueDate: false,
      subtype: false,
      apy: false,
    });
  });

  it("exposes the last statement as reported by the bank", () => {
    const summary = toAccountSummary({
      ...base,
      statementBalance: 45210n,
      statementDate: "2026-09-12",
      minimumPayment: 3500n,
      apr: 24.99,
    } as AccountWithItem);
    expect(summary).toMatchObject({
      statementBalance: "45210",
      statementDate: "2026-09-12",
      minimumPayment: "3500",
      apr: 24.99,
    });
  });

  it("returns nulls when the bank reports no statement", () => {
    expect(toAccountSummary(base)).toMatchObject({
      statementBalance: null,
      statementDate: null,
      minimumPayment: null,
      apr: null,
    });
  });

  it("uses the user's checking/savings choice and rate, keeping the bank's alongside", () => {
    const savings = {
      ...base,
      type: "depository",
      subtype: "checking",
      apy: 0.01,
      subtypeOverride: "savings",
      apyOverride: 4.25,
    } as unknown as AccountWithItem;
    const summary = toAccountSummary(savings);
    expect(summary.subtype).toBe("savings");
    expect(summary.apy).toBe(4.25);
    expect(summary.bank).toMatchObject({ subtype: "checking", apy: 0.01 });
    expect(summary.overridden).toMatchObject({ subtype: true, apy: true });

    const bankOnly = toAccountSummary({
      ...savings,
      subtypeOverride: null,
      apyOverride: null,
    } as AccountWithItem);
    expect(bankOnly.subtype).toBe("checking");
    expect(bankOnly.apy).toBe(0.01);
    expect(bankOnly.overridden).toMatchObject({ subtype: false, apy: false });
  });
});
