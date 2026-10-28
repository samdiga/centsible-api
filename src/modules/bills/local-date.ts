/** The calendar date `now` falls on in `timezone`; an unknown zone name falls back to UTC. */
export function dateInTimeZone(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * A bill is overdue only from the day after its due date in the user's own
 * calendar: one due today is still upcoming, however late in the day.
 */
export const isPastDue = (effectiveDueDate: string, today: string) =>
  effectiveDueDate < today;
