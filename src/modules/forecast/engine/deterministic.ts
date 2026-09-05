import type { DayForecast, ForecastInput, ForecastResult } from "./types.js";

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Generates the v1 deterministic cash-horizon projection. */
export function generateForecast(input: ForecastInput): ForecastResult {
  if (input.horizonDays <= 0) throw new Error("horizonDays must be positive");

  const eventsByDate = new Map<string, typeof input.events>();
  for (const event of input.events) {
    const events = eventsByDate.get(event.date) ?? [];
    events.push(event);
    eventsByDate.set(event.date, events);
  }

  let running = input.startingBalanceCents;
  const days: DayForecast[] = [];
  for (let offset = 0; offset < input.horizonDays; offset += 1) {
    const date = addDays(input.today, offset);
    const events = eventsByDate.get(date) ?? [];
    for (const event of events) running -= event.amountCents;
    running -= input.discretionaryDailyAvgCents;
    days.push({
      date,
      p50Cents: running,
      p10Cents: running,
      p90Cents: running,
      events,
    });
  }

  const tightest = days.reduce(
    (minimum, day) => (day.p50Cents < minimum.p50Cents ? day : minimum),
    days[0]!,
  );
  return {
    days,
    tightestDay: { date: tightest.date, balanceCents: tightest.p50Cents },
    algorithmVersion: "v1",
  };
}
