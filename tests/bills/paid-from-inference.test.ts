import { describe, expect, it } from "vitest";
import {
  inferBillAccount,
  majorityAccount,
} from "../../src/modules/bills/paid-from-inference.js";
const bill = {
  id: "bill",
  canonicalName: "merchant",
  merchantPatterns: [],
  billType: "payable" as const,
  toAccountId: null,
  isIncome: false,
};
const payment = {
  accountId: "cash",
  accountType: "depository",
  date: "2026-09-01",
  amount: 100n,
  recurringSeriesId: null,
  merchantKey: "merchant",
  isTransfer: false,
  currency: "USD",
};
describe("paid-from evidence", () => {
  it("leaves empty and tied evidence unresolved", () => {
    expect(majorityAccount([])).toBeNull();
    expect(majorityAccount(["a", "b", "a", "b"])).toBeNull();
    expect(majorityAccount(["a", "b", "a"])).toEqual({
      accountId: "a",
      votes: 2,
      samples: 3,
    });
  });
  it("honors explicit series links instead of crossing another series with the same merchant", () => {
    expect(
      inferBillAccount(
        bill,
        [{ ...payment, recurringSeriesId: "other" }],
        new Set(),
      ),
    ).toBeNull();
    expect(
      inferBillAccount(
        bill,
        [{ ...payment, recurringSeriesId: "bill", merchantKey: "changed" }],
        new Set(),
      )?.accountId,
    ).toBe("cash");
  });
  it("routes paycheck inflows and excludes opposite signs and unlinked transfers", () => {
    expect(
      inferBillAccount(
        { ...bill, isIncome: true },
        [payment, { ...payment, amount: -100n }],
        new Set(),
      )?.samples,
    ).toBe(1);
    expect(
      inferBillAccount(bill, [{ ...payment, isTransfer: true }], new Set()),
    ).toBeNull();
  });
  it("rejects currency mismatch, distant payments, loans and ambiguous sources", () => {
    const cardBill = {
      ...bill,
      billType: "transfer" as const,
      toAccountId: "card",
    };
    const inflow = {
      ...payment,
      accountId: "card",
      accountType: "credit",
      amount: -10000n,
    };
    const cash = { ...payment, amount: 10000n };
    expect(
      inferBillAccount(cardBill, [inflow, cash], new Set(["card"]))?.accountId,
    ).toBe("cash");
    for (const evidence of [
      [inflow, { ...cash, currency: "CAD" }],
      [inflow, { ...cash, date: "2026-09-05" }],
      [inflow, { ...cash, amount: 10101n }],
      [inflow, cash, { ...cash, accountId: "other" }],
    ])
      expect(
        inferBillAccount(cardBill, evidence, new Set(["card"])),
      ).toBeNull();
    expect(inferBillAccount(cardBill, [inflow, cash], new Set())).toBeNull();
  });
});
