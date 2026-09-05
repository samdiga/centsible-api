import type { ForecastWireDay, ForecastWireEvent } from "./types.js";

export type OneOffExpense = Readonly<{
  id: string;
  name: string;
  amountCents: bigint;
  date: string;
}>;

/** Applies skipped recurring series to an already serialized forecast. */
export function applySkipScenarios(
  days: ForecastWireDay[],
  skippedSeriesIds: Set<string>,
): ForecastWireDay[] {
  if (skippedSeriesIds.size === 0) return days;
  let recoveredCents = 0n;
  return days.map((day) => {
    const skipped = day.events.filter(
      (event) =>
        event.recurringSeriesId !== null &&
        event.recurringSeriesId !== undefined &&
        skippedSeriesIds.has(event.recurringSeriesId),
    );
    for (const event of skipped) recoveredCents += BigInt(event.amountCents);
    return {
      ...day,
      p50Cents: (BigInt(day.p50Cents) + recoveredCents).toString(),
      p10Cents: (BigInt(day.p10Cents) + recoveredCents).toString(),
      p90Cents: (BigInt(day.p90Cents) + recoveredCents).toString(),
      events: day.events.filter((event) => !skipped.includes(event)),
    };
  });
}

/** Adds one-off expenses to a serialized forecast and cascades their cost. */
export function applyAddExpenses(
  days: ForecastWireDay[],
  expenses: OneOffExpense[],
): ForecastWireDay[] {
  if (expenses.length === 0) return days;
  const byDate = new Map<string, OneOffExpense[]>();
  for (const expense of expenses) {
    const entries = byDate.get(expense.date) ?? [];
    entries.push(expense);
    byDate.set(expense.date, entries);
  }

  let addedCostCents = 0n;
  return days.map((day) => {
    const added = byDate.get(day.date) ?? [];
    for (const expense of added) addedCostCents += expense.amountCents;
    const events: ForecastWireEvent[] = added.map((expense) => ({
      name: expense.name,
      amountCents: expense.amountCents.toString(),
      confidence: 1,
      sourceType: "manual",
      sourceId: expense.id,
      recurringSeriesId: null,
    }));
    return {
      ...day,
      p50Cents: (BigInt(day.p50Cents) - addedCostCents).toString(),
      p10Cents: (BigInt(day.p10Cents) - addedCostCents).toString(),
      p90Cents: (BigInt(day.p90Cents) - addedCostCents).toString(),
      events: events.length > 0 ? [...day.events, ...events] : day.events,
    };
  });
}
