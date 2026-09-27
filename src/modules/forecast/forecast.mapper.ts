import type { AccountsResult, AccountEvent } from "./engine/accounts.js";
import type { ForecastResult } from "./engine/types.js";
import type { ForecastResponse } from "./forecast.schemas.js";

/** Converts bigint engine values to the stable decimal-string wire contract. */
export function toForecastResponse(
  result: ForecastResult | AccountsResult,
  horizonDays: number,
): ForecastResponse {
  return {
    days: result.days.map((day) => ({
      date: day.date,
      p50Cents: day.p50Cents.toString(),
      p10Cents: day.p10Cents.toString(),
      p90Cents: day.p90Cents.toString(),
      events: day.events.map((event) => ({
        ...("accountId" in event
          ? { accountId: (event as AccountEvent).accountId }
          : {}),
        ...(event.estimated === undefined
          ? {}
          : { estimated: event.estimated }),
        name: event.name,
        amountCents: event.amountCents.toString(),
        confidence: event.confidence,
        sourceType: event.sourceType,
        ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
        recurringSeriesId: event.recurringSeriesId ?? null,
      })),
    })),
    tightestDay: {
      date: result.tightestDay.date,
      balanceCents: result.tightestDay.balanceCents.toString(),
    },
    algorithmVersion: result.algorithmVersion,
    horizonDays,
    ...("accounts" in result
      ? {
          accounts: result.accounts.map((a) => ({
            ...a,
            balances: a.balances.map(String),
          })),
          cashWarnings: result.cashWarnings.map((w) => ({
            ...w,
            lowestCents: String(w.lowestCents),
          })),
          cardStatements: result.cardStatements.map((c) => ({
            ...c,
            amountCents: String(c.amountCents),
            paymentCents: String(c.paymentCents),
          })),
          unassignedBillCount: result.unassignedBillCount,
        }
      : {}),
  };
}
