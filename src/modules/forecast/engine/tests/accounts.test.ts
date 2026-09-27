import { describe, expect, it } from "vitest";
import {
  addMonths,
  cardPaymentFor,
  deriveCycle,
  generateAccountsForecast,
  UNASSIGNED_CASH,
  type EngineCard,
  type AccountsInput,
} from "../accounts.js";
import { generateForecast } from "../deterministic.js";
const card = (patch: Partial<EngineCard> = {}): EngineCard => ({
  billedCents: 10000n,
  unbilledCents: 0n,
  creditsSinceCloseCents: 0n,
  statementDate: "2026-08-31",
  paymentDueDate: "2026-09-25",
  minimumPaymentCents: 1000n,
  lastPaymentCents: 2000n,
  rule: { kind: "full" },
  statementPaymentOverrideCents: null,
  payFromAccountId: "cash",
  ...patch,
});
const input = (
  c: EngineCard = card(),
  patch: Partial<AccountsInput> = {},
): AccountsInput => ({
  today: "2026-09-20",
  horizonDays: 40,
  accounts: [
    {
      id: "cash",
      name: "Checking",
      kind: "cash",
      startingBalanceCents: 100000n,
    },
    {
      id: "card",
      name: "Card",
      kind: "card",
      startingBalanceCents:
        c.billedCents + c.unbilledCents - c.creditsSinceCloseCents,
      card: c,
    },
  ],
  events: [],
  dailySpendByAccount: new Map(),
  unassignedBillCount: 0,
  ...patch,
});
describe("account-aware forecast", () => {
  it("card charges leave cash alone until payment and ignores transfer occurrence inputs", () => {
    const result = generateAccountsForecast(
      input(card(), {
        events: [
          {
            date: "2026-09-20",
            name: "Bill",
            amountCents: 500n,
            confidence: 1,
            sourceType: "recurring",
            accountId: "card",
          },
          {
            date: "2026-09-25",
            name: "Old card occurrence",
            amountCents: 10000n,
            confidence: 1,
            sourceType: "recurring",
            accountId: "cash",
            cardPayment: true,
          },
        ],
      }),
    );
    expect(result.days[0]?.p50Cents).toBe(100000n);
    expect(result.days[5]?.p50Cents).toBe(90000n);
    expect(result.accounts.find((a) => a.id === "card")?.balances[5]).toBe(
      500n,
    );
    expect(
      result.days[5]?.events.filter((e) => e.sourceType === "card_payment"),
    ).toHaveLength(2);
    expect(
      result.days[5]?.events.some((e) => e.name === "Old card occurrence"),
    ).toBe(false);
  });
  it("floors every rule at minimum and caps at owed", () => {
    expect(
      cardPaymentFor(card({ rule: { kind: "planned", amountCents: 100n } }))
        .amountCents,
    ).toBe(1000n);
    expect(
      cardPaymentFor(card({ rule: { kind: "planned", amountCents: 50000n } }))
        .amountCents,
    ).toBe(10000n);
    expect(
      cardPaymentFor(
        card({ billedCents: 500n, rule: { kind: "planned", amountCents: 0n } }),
      ).amountCents,
    ).toBe(500n);
    expect(
      cardPaymentFor(card({ creditsSinceCloseCents: 20000n })).amountCents,
    ).toBe(0n);
  });
  it("uses interest-saving override or estimated max(min,last payment)", () => {
    expect(cardPaymentFor(card({ rule: { kind: "interest_saving" } }))).toEqual(
      { amountCents: 2000n, estimated: true },
    );
    expect(
      cardPaymentFor(
        card({
          rule: { kind: "interest_saving" },
          statementPaymentOverrideCents: 5000n,
        }),
      ),
    ).toEqual({ amountCents: 5000n, estimated: false });
    const r = generateAccountsForecast(
      input(
        card({
          rule: { kind: "interest_saving" },
          statementPaymentOverrideCents: 5000n,
        }),
      ),
    );
    expect(r.cardStatements[0]?.estimated).toBe(false);
    expect(r.cardStatements[1]?.estimated).toBe(true);
  });
  it("subtracts Venture X post-close credits exactly once", () => {
    const r = generateAccountsForecast(
      input(card({ billedCents: 277518n, creditsSinceCloseCents: 9539n }), {
        horizonDays: 6,
      }),
    );
    expect(r.cardStatements[0]?.paymentCents).toBe(267979n);
    expect(r.days[5]?.p50Cents).toBe(100000n - 267979n);
    expect(r.accounts.find((a) => a.id === "card")?.balances[5]).toBe(0n);
  });
  it("future refunds reduce card owed and the current full payment, not cash", () => {
    const r = generateAccountsForecast(
      input(card(), {
        horizonDays: 6,
        events: [
          {
            date: "2026-09-21",
            name: "Refund",
            amountCents: -3000n,
            confidence: 1,
            sourceType: "pending_transaction",
            accountId: "card",
            cardCredit: true,
          },
        ],
      }),
    );
    expect(r.days[1]?.p50Cents).toBe(100000n);
    expect(r.accounts.find((a) => a.id === "card")?.balances[1]).toBe(7000n);
    expect(r.days[5]?.p50Cents).toBe(93000n);
  });
  it("keeps month-end anchors across February including leap years", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    const r = generateAccountsForecast(
      input(
        card({
          statementDate: "2026-01-31",
          paymentDueDate: "2026-02-25",
          billedCents: 0n,
          unbilledCents: 1000n,
        }),
        { today: "2026-02-01", horizonDays: 90 },
      ),
    );
    expect(r.cardStatements.map((s) => s.closeDate)).toEqual(
      expect.arrayContaining(["2026-02-28", "2026-03-31", "2026-04-30"]),
    );
  });
  it("derives BoA cycle from due minus25 unless payment days cluster", () => {
    const c = card({
      statementDate: null,
      paymentDueDate: "2026-10-15",
      paymentDates: ["2026-06-02", "2026-07-15", "2026-08-28"],
    });
    expect(deriveCycle(c, "2026-09-20")).toEqual({
      close: "2026-09-20",
      offset: 25,
      estimated: true,
    });
    expect(
      deriveCycle(
        { ...c, paymentDates: ["2026-06-10", "2026-07-12", "2026-08-11"] },
        "2026-09-20",
      )?.close,
    ).toBe("2026-09-16");
    const r = generateAccountsForecast(
      input(
        { ...c, rule: { kind: "planned", amountCents: 2000n } },
        { today: "2026-10-10", horizonDays: 6 },
      ),
    );
    expect(r.days[5]?.p50Cents).toBe(98000n);
    expect(r.cardStatements[0]?.cycleEstimated).toBe(true);
  });
  it("skips a paid stale cycle, keeps unpaid due today, never counts a refund as payment", () => {
    const overdue = card({
      paymentDueDate: "2026-09-15",
      paymentsSinceCloseCents: 0n,
    });
    const unpaid = generateAccountsForecast(input(overdue, { horizonDays: 1 }));
    expect(unpaid.days[0]?.p50Cents).toBe(90000n);
    expect(unpaid.cardStatements[0]?.overdue).toBe(true);
    const paid = generateAccountsForecast(
      input(
        {
          ...overdue,
          billedCents: 0n,
          originalBilledCents: 10000n,
          paymentsSinceCloseCents: 10000n,
        },
        { horizonDays: 1 },
      ),
    );
    expect(paid.days[0]?.p50Cents).toBe(100000n);
    expect(paid.cardStatements).toEqual([]);
    const refunded = generateAccountsForecast(
      input(
        {
          ...overdue,
          creditsSinceCloseCents: 9000n,
          rule: { kind: "planned", amountCents: 1000n },
        },
        { horizonDays: 1 },
      ),
    );
    expect(refunded.cardStatements[0]?.overdue).toBe(true);
    expect(refunded.days[0]?.p50Cents).toBe(99000n);
  });
  it("uses Unassigned cash conservatively and external payments leave cash alone", () => {
    const r = generateAccountsForecast(
      input(card({ payFromAccountId: null }), {
        events: [
          {
            date: "2026-09-20",
            name: "Unassigned",
            amountCents: 100n,
            confidence: 1,
            sourceType: "manual",
            accountId: null,
          },
        ],
      }),
    );
    for (let i = 0; i < r.days.length; i++)
      expect(r.days[i]?.p50Cents).toBe(
        r.accounts
          .filter((a) => a.kind === "cash")
          .reduce((sum, a) => sum + a.balances[i]!, 0n),
      );
    expect(r.accounts.some((a) => a.id === UNASSIGNED_CASH)).toBe(true);
    const external = generateAccountsForecast(
      input(card({ paidFromExternal: true }), { horizonDays: 6 }),
    );
    expect(external.days[5]?.p50Cents).toBe(100000n);
    expect(external.accounts.find((a) => a.id === "card")?.balances[5]).toBe(
      0n,
    );
  });
  it("warns about a negative cash account even when combined cash stays positive", () => {
    const r = generateAccountsForecast(
      input(card(), {
        horizonDays: 1,
        accounts: [
          { id: "a", name: "Small", kind: "cash", startingBalanceCents: 100n },
          {
            id: "b",
            name: "Large",
            kind: "cash",
            startingBalanceCents: 10000n,
          },
        ],
        events: [
          {
            date: "2026-09-20",
            name: "Expense",
            amountCents: 500n,
            confidence: 1,
            sourceType: "manual",
            accountId: "a",
          },
        ],
      }),
    );
    expect(r.days[0]?.p50Cents).toBe(9600n);
    expect(r.cashWarnings[0]).toMatchObject({
      accountId: "a",
      lowestCents: -400n,
      firstNegativeDate: "2026-09-20",
    });
  });
  it("with no cards and all cash bills matches v1 every day", () => {
    const events = [
      {
        date: "2026-09-22",
        name: "Bill",
        amountCents: 1000n,
        confidence: 1,
        sourceType: "recurring" as const,
      },
      {
        date: "2026-09-25",
        name: "Income",
        amountCents: -10000n,
        confidence: 1,
        sourceType: "recurring" as const,
      },
    ];
    const legacy = generateForecast({
      today: "2026-09-20",
      horizonDays: 30,
      startingBalanceCents: 100000n,
      events,
      discretionaryDailyAvgCents: 500n,
    });
    const v2 = generateAccountsForecast(
      input(card(), {
        horizonDays: 30,
        accounts: [
          {
            id: "cash",
            name: "Cash",
            kind: "cash",
            startingBalanceCents: 100000n,
          },
        ],
        events: events.map((e) => ({ ...e, accountId: "cash" })),
        dailySpendByAccount: new Map([["cash", 500n]]),
      }),
    );
    expect(v2.days.map((d) => d.p50Cents)).toEqual(
      legacy.days.map((d) => d.p50Cents),
    );
    expect(v2.tightestDay).toEqual(legacy.tightestDay);
  });
  it("cards with no statement or due date project new charges without inventing payments", () => {
    const r = generateAccountsForecast(
      input(
        card({
          statementDate: null,
          paymentDueDate: null,
          billedCents: 0n,
          unbilledCents: 2000n,
        }),
        { dailySpendByAccount: new Map([["card", 100n]]), horizonDays: 3 },
      ),
    );
    expect(r.cardStatements).toEqual([]);
    expect(r.accounts.find((a) => a.id === "card")?.balances).toEqual([
      2100n,
      2200n,
      2300n,
    ]);
    expect(r.days.at(-1)?.p50Cents).toBe(100000n);
  });
});

describe("hostile card inputs", () => {
  it("retains excess refunds as a credit balance after due and close", () => {
    const r = generateAccountsForecast(
      input(card({ creditsSinceCloseCents: 15000n }), { horizonDays: 12 }),
    );
    expect(r.accounts.find((a) => a.id === "card")?.balances[5]).toBe(-5000n);
    expect(r.accounts.find((a) => a.id === "card")?.balances[10]).toBe(-5000n);
    expect(r.days[5]?.p50Cents).toBe(100000n);
  });
  it("pays each original cycle even when its due date follows the next close", () => {
    const r = generateAccountsForecast(
      input(
        card({
          statementDate: "2026-08-01",
          paymentDueDate: "2026-09-10",
          unbilledCents: 2000n,
        }),
        { today: "2026-09-01", horizonDays: 11 },
      ),
    );
    expect(r.days[0]?.p50Cents).toBe(100000n);
    expect(r.accounts.find((a) => a.id === "card")?.balances[0]).toBe(12000n);
    expect(r.days[9]?.p50Cents).toBe(90000n);
    expect(r.accounts.find((a) => a.id === "card")?.balances[9]).toBe(2000n);
  });
  it("retains an unassigned cash series even when its final balance returns to zero", () => {
    const r = generateAccountsForecast(
      input(card(), {
        horizonDays: 2,
        accounts: [],
        events: [
          {
            date: "2026-09-20",
            name: "Out",
            amountCents: 100n,
            confidence: 1,
            sourceType: "manual",
            accountId: null,
          },
          {
            date: "2026-09-21",
            name: "In",
            amountCents: -100n,
            confidence: 1,
            sourceType: "manual",
            accountId: null,
          },
        ],
      }),
    );
    expect(r.accounts.find((a) => a.id === UNASSIGNED_CASH)?.balances).toEqual([
      -100n,
      0n,
    ]);
  });
});
