import { describe, expect, it } from "vitest";

import { generateAccountsForecast } from "../engine/accounts.js";
import { generateForecast } from "../engine/deterministic.js";
import { toForecastResponse } from "../forecast.mapper.js";

const categoryId = "00000000-0000-4000-8000-000000000001";
const tagId = "00000000-0000-4000-8000-000000000002";

describe("forecast event metadata", () => {
  it("preserves source category and tags without changing balances", () => {
    const result = generateForecast({
      today: "2026-09-29",
      horizonDays: 1,
      startingBalanceCents: 10_000n,
      discretionaryDailyAvgCents: 0n,
      events: [
        {
          date: "2026-09-29",
          amountCents: 500n,
          name: "Recurring",
          confidence: 0.9,
          sourceType: "recurring",
          categoryId,
          tagIds: [],
        },
        {
          date: "2026-09-29",
          amountCents: -200n,
          name: "Pending",
          confidence: 0.7,
          sourceType: "pending_transaction",
          categoryId,
          tagIds: [tagId],
        },
        {
          date: "2026-09-29",
          amountCents: 100n,
          name: "Manual",
          confidence: 0.9,
          sourceType: "manual",
        },
      ],
    });

    const response = toForecastResponse(result, 1);
    expect(response.days[0]?.p50Cents).toBe("9600");
    expect(
      response.days[0]?.events.map(({ categoryId, tagIds }) => ({
        categoryId,
        tagIds,
      })),
    ).toEqual([
      { categoryId, tagIds: [] },
      { categoryId, tagIds: [tagId] },
      { categoryId: null, tagIds: [] },
    ]);
  });

  it("returns null and empty tags for synthetic card payments and interest", () => {
    const result = generateAccountsForecast({
      today: "2026-09-30",
      horizonDays: 1,
      accounts: [
        {
          id: "cash",
          name: "Cash",
          kind: "cash",
          startingBalanceCents: 10_000n,
          savingsInterest: {
            apy: 0,
            creditDay: 30,
            accruedScaledCents: 1_000_000_000_000n,
            creditedMonths: [],
          },
        },
        {
          id: "card",
          name: "Card",
          kind: "card",
          startingBalanceCents: 500n,
          card: {
            billedCents: 500n,
            unbilledCents: 0n,
            creditsSinceCloseCents: 0n,
            statementDate: "2026-09-01",
            paymentDueDate: "2026-09-30",
            minimumPaymentCents: 0n,
            lastPaymentCents: 0n,
            rule: { kind: "full" },
            statementPaymentOverrideCents: null,
            payFromAccountId: "cash",
          },
        },
      ],
      events: [],
      dailySpendByAccount: new Map(),
      unassignedBillCount: 0,
    });
    const events = toForecastResponse(result, 1).days[0]?.events ?? [];
    expect(
      events.filter((event) => event.sourceType === "card_payment"),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.sourceType === "savings_interest"),
    ).toHaveLength(1);
    expect(
      events.every(
        (event) => event.categoryId === null && event.tagIds?.length === 0,
      ),
    ).toBe(true);
  });
});
