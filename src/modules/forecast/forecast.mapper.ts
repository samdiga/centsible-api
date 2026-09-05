import type { ForecastResult } from "./engine/types.js";
import type { ForecastResponse } from "./forecast.schemas.js";

/** Converts bigint engine values to the stable decimal-string wire contract. */
export function toForecastResponse(
  result: ForecastResult,
  horizonDays: number,
): ForecastResponse {
  return {
    days: result.days.map((day) => ({
      date: day.date,
      p50Cents: day.p50Cents.toString(),
      p10Cents: day.p10Cents.toString(),
      p90Cents: day.p90Cents.toString(),
      events: day.events.map((event) => ({
        name: event.name,
        amountCents: event.amountCents.toString(),
        confidence: event.confidence,
        sourceType: event.sourceType,
        ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
        ...(event.recurringSeriesId === undefined
          ? {}
          : { recurringSeriesId: event.recurringSeriesId }),
      })),
    })),
    tightestDay: {
      date: result.tightestDay.date,
      balanceCents: result.tightestDay.balanceCents.toString(),
    },
    algorithmVersion: result.algorithmVersion,
    horizonDays,
  };
}
