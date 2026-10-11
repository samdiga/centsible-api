import { describe, expect, it } from "vitest";

import type { UpcomingBillRow } from "../dashboard.repository.js";
import { computeSafeToSpendByAccount } from "../safe-to-spend-by-account.js";

const CHECKING = "checking";
const SAVINGS = "savings";
const CARD = "card";
const PERIOD_END = "2026-10-31";

let next = 0;
const bill = (
  dueDate: string,
  cents: bigint,
  overrides: Partial<UpcomingBillRow> = {},
): UpcomingBillRow => ({
  id: `bill-${(next += 1)}`,
  occurrenceId: `occ-${next}`,
  canonicalName: `bill ${next}`,
  displayName: null,
  dueDate,
  amount: cents,
  cadence: "monthly",
  status: "upcoming",
  hasPayment: false,
  payFromAccountId: CHECKING,
  billType: "payable",
  toAccountId: null,
  ...overrides,
});

const accounts = [
  { id: CHECKING, name: "Checking", currentBalance: 200_000n },
  { id: SAVINGS, name: "Savings", currentBalance: null },
];

const compute = (
  bills: UpcomingBillRow[],
  cardPayments: Parameters<
    typeof computeSafeToSpendByAccount
  >[0]["cardPayments"] = [],
) =>
  computeSafeToSpendByAccount({
    accounts,
    bills,
    cardPayments,
    periodEnd: PERIOD_END,
  });

describe("computeSafeToSpendByAccount", () => {
  it("gives every cash account a row, bills or not", () => {
    const result = compute([bill("2026-10-10", 5_000n)]);
    expect(result.accounts).toEqual([
      {
        accountId: CHECKING,
        name: "Checking",
        balanceCents: 200_000n,
        billsDueCents: 5_000n,
        safeToSpendCents: 195_000n,
        billCount: 1,
      },
      {
        accountId: SAVINGS,
        name: "Savings",
        balanceCents: 0n,
        billsDueCents: 0n,
        safeToSpendCents: 0n,
        billCount: 0,
      },
    ]);
  });

  it("counts through the last day of the month, not the day after", () => {
    const result = compute([
      bill("2026-10-31", 1_000n),
      bill("2026-11-01", 9_000n),
    ]);
    expect(result.accounts[0]).toMatchObject({
      billsDueCents: 1_000n,
      billCount: 1,
    });
  });

  it("keeps a bill marked paid by hand until its payment is at the bank", () => {
    const result = compute([
      bill("2026-10-10", 1_000n, { status: "processing" }),
      bill("2026-10-11", 2_000n, { status: "processing", hasPayment: true }),
      bill("2026-09-30", 4_000n, { status: "overdue" }),
    ]);
    // Overdue and unpaid: the money is still in the account.
    expect(result.accounts[0]).toMatchObject({
      billsDueCents: 5_000n,
      billCount: 2,
    });
  });

  it("counts a bill without Paid-from but never subtracts it", () => {
    const result = compute([
      bill("2026-10-10", 1_000n, { payFromAccountId: null }),
      bill("2026-11-10", 1_000n, { payFromAccountId: null }),
    ]);
    expect(result.unassignedBillCount).toBe(1);
    expect(result.accounts.map((row) => row.billsDueCents)).toEqual([0n, 0n]);
  });

  it("ignores bills paid from a non-cash account", () => {
    const result = compute([
      bill("2026-10-10", 1_000n, { payFromAccountId: CARD }),
    ]);
    expect(result.unassignedBillCount).toBe(0);
    expect(result.accounts[0]?.billsDueCents).toBe(0n);
  });

  it("uses the projected card payment for that statement's month", () => {
    const cardBill = (overrides: Partial<UpcomingBillRow> = {}) =>
      bill("2026-10-25", 80_000n, {
        billType: "transfer",
        toAccountId: CARD,
        ...overrides,
      });
    const projection = [
      { cardAccountId: CARD, dueDate: "2026-10-24", paymentCents: 25_000n },
    ];
    expect(compute([cardBill()], projection).accounts[0]?.billsDueCents).toBe(
      25_000n,
    );
    // No projection for the card: the statement amount.
    expect(compute([cardBill()]).accounts[0]?.billsDueCents).toBe(80_000n);
    // Marked paid by hand: what the user recorded, not the projection.
    expect(
      compute([cardBill({ status: "processing" })], projection).accounts[0]
        ?.billsDueCents,
    ).toBe(80_000n);
  });
});
