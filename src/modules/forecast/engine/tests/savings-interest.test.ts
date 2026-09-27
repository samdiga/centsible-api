import { describe, expect, it } from "vitest";
import { generateAccountsForecast, type AccountsInput } from "../accounts.js";
import {
  accrueInterest,
  dailyYieldScaled,
  INTEREST_SCALE,
} from "../savings-interest.js";
import { toForecastResponse } from "../../forecast.mapper.js";
const input = (patch: Partial<AccountsInput> = {}): AccountsInput => ({
  today: "2026-09-01",
  horizonDays: 30,
  accounts: [
    {
      id: "savings",
      name: "Savings",
      kind: "cash",
      startingBalanceCents: 100000n,
      savingsInterest: {
        apy: 4,
        accruedScaledCents: 0n,
        creditDay: 31,
        creditedMonths: [],
      },
    },
  ],
  events: [],
  dailySpendByAccount: new Map(),
  unassignedBillCount: 0,
  ...patch,
});
describe("estimated savings interest", () => {
  it("credits month-end only, on the savings account, with a labelled integer-cent inflow", () => {
    const result = generateAccountsForecast(input());
    expect(result.days[28]?.p50Cents).toBe(100000n);
    expect(result.days[29]?.p50Cents).toBe(100322n);
    const event = result.days[29]?.events[0];
    expect(event).toMatchObject({
      sourceType: "savings_interest",
      amountCents: -322n,
      accountId: "savings",
      estimated: true,
    });
    expect(toForecastResponse(result, 30).days[29]?.events[0]).toMatchObject({
      estimated: true,
      amountCents: "-322",
    });
  });
  it("a known actual interest event replaces the whole month's estimate without double counting", () => {
    const result = generateAccountsForecast(
      input({
        events: [
          {
            date: "2026-09-30",
            amountCents: -350n,
            name: "Actual bank interest",
            confidence: 1,
            sourceType: "pending_transaction",
            accountId: "savings",
            interestDeposit: true,
          },
        ],
      }),
    );
    expect(result.days[29]?.p50Cents).toBe(100350n);
    expect(result.days[29]?.events).toHaveLength(1);
    expect(result.days[29]?.events[0]?.sourceType).toBe("pending_transaction");
  });
  it("does not estimate a month already credited before today", () => {
    const data = input();
    data.accounts[0]!.savingsInterest!.creditedMonths = ["2026-09"];
    const result = generateAccountsForecast(data);
    expect(result.days[29]?.p50Cents).toBe(100000n);
    expect(result.days[29]?.events).toEqual([]);
  });
  it("uses the forecast balance after withdrawals, not an unchanged starting balance", () => {
    const full = generateAccountsForecast(input());
    const withdrawn = generateAccountsForecast(
      input({
        events: [
          {
            date: "2026-09-15",
            amountCents: 50000n,
            name: "Withdrawal",
            confidence: 1,
            sourceType: "manual",
            accountId: "savings",
          },
        ],
      }),
    );
    const estimate = withdrawn.days[29]?.events[0]?.amountCents;
    expect(estimate! > -322n).toBe(true);
    expect(withdrawn.days[29]?.p50Cents).toBe(50000n - estimate!);
    expect(full.days[29]?.p50Cents).toBe(100322n);
  });
  it("does not invent a missing/zero rate or interest on a nonpositive balance", () => {
    for (const balance of [0n, -1000n])
      expect(
        generateAccountsForecast(
          input({
            accounts: [
              {
                id: "savings",
                name: "Savings",
                kind: "cash",
                startingBalanceCents: balance,
                savingsInterest: {
                  apy: 4,
                  accruedScaledCents: 0n,
                  creditDay: 31,
                  creditedMonths: [],
                },
              },
            ],
          }),
        ).days[29]?.events,
      ).toEqual([]);
    expect(
      generateAccountsForecast(
        input({
          accounts: [
            {
              id: "cash",
              name: "Cash",
              kind: "cash",
              startingBalanceCents: 100000n,
            },
          ],
        }),
      ).days[29]?.events,
    ).toEqual([]);
    for (const rate of [0, -1, NaN, Infinity, 101])
      expect(dailyYieldScaled(rate, "2026-09-01")).toBe(0n);
  });
  it("clamps end-month credit dates in February and handles leap-year yield", () => {
    const result = generateAccountsForecast(
      input({ today: "2028-02-01", horizonDays: 29 }),
    );
    expect(result.days[27]?.events).toEqual([]);
    expect(result.days[28]?.events[0]?.sourceType).toBe("savings_interest");
    expect(
      dailyYieldScaled(4, "2028-02-01") < dailyYieldScaled(4, "2026-02-01"),
    ).toBe(true);
  });
  it("preserves bigint principal precision and never serializes subcents", () => {
    const principal = 9_007_199_254_741_123n;
    const accrued = accrueInterest(principal, 0n, 4, "2026-09-01");
    expect(accrued).toBe(principal * dailyYieldScaled(4, "2026-09-01"));
    const result = generateAccountsForecast(
      input({
        today: "2026-09-30",
        horizonDays: 1,
        accounts: [
          {
            id: "savings",
            name: "Savings",
            kind: "cash",
            startingBalanceCents: principal,
            savingsInterest: {
              apy: 4,
              accruedScaledCents: 0n,
              creditDay: 31,
              creditedMonths: [],
            },
          },
        ],
      }),
    );
    expect(result.days[0]?.p50Cents).toBe(principal + accrued / INTEREST_SCALE);
    expect(() => JSON.stringify(toForecastResponse(result, 1))).not.toThrow();
  });
});
