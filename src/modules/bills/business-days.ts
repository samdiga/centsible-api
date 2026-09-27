/**
 * US banking days, for pay schedules that move off weekends and holidays.
 *
 * Holidays follow the Federal Reserve's calendar: a holiday on a Sunday is
 * observed on the Monday; one on a Saturday is not moved (the Fed stays open
 * on the Friday), which doesn't matter here because Saturday is never a
 * business day anyway. All dates are ISO `YYYY-MM-DD` strings in UTC.
 */

const iso = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

const parse = (date: string) => {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return { year, month, day };
};

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const shift = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** The `n`th given weekday (0 = Sunday) of a month; `n = -1` is the last one. */
function nthWeekday(year: number, month: number, dow: number, n: number) {
  if (n === -1) {
    const last = new Date(Date.UTC(year, month, 0));
    const back = (last.getUTCDay() - dow + 7) % 7;
    return iso(year, month, last.getUTCDate() - back);
  }
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return iso(year, month, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}

const observed = (date: string) => (weekday(date) === 0 ? shift(date, 1) : date);

const holidayCache = new Map<number, Set<string>>();

/** Federal Reserve bank holidays observed in `year`. */
export function bankHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const holidays = new Set([
    observed(iso(year, 1, 1)),
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Washington's Birthday
    nthWeekday(year, 5, 1, -1), // Memorial Day
    observed(iso(year, 6, 19)), // Juneteenth
    observed(iso(year, 7, 4)),
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    observed(iso(year, 11, 11)), // Veterans Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observed(iso(year, 12, 25)),
  ]);
  holidayCache.set(year, holidays);
  return holidays;
}

export function isBusinessDay(date: string): boolean {
  const day = weekday(date);
  return day !== 0 && day !== 6 && !bankHolidays(parse(date).year).has(date);
}

/** `date` itself when it's a business day, otherwise the closest business day before it. */
export function onOrBeforeBusinessDay(date: string): string {
  let cursor = date;
  while (!isBusinessDay(cursor)) cursor = shift(cursor, -1);
  return cursor;
}

/**
 * Semi-monthly pay dates for a month: the 15th and the last day of the month,
 * each moved to the business day before when it isn't one. This is the
 * schedule US payroll most often uses ("15th and last business day").
 */
export function semimonthlyPayDates(year: number, month: number): [string, string] {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    onOrBeforeBusinessDay(iso(year, month, 15)),
    onOrBeforeBusinessDay(iso(year, month, lastDay)),
  ];
}

/** The first semi-monthly pay date strictly after `date`. */
export function nextSemimonthlyPayDate(date: string): string {
  const { year, month } = parse(date);
  for (let offset = 0; offset < 3; offset += 1) {
    const index = month - 1 + offset;
    const candidates = semimonthlyPayDates(
      year + Math.floor(index / 12),
      (index % 12) + 1,
    );
    const next = candidates.find((candidate) => candidate > date);
    if (next) return next;
  }
  // Unreachable: every month has two pay dates.
  throw new Error(`No semi-monthly pay date after ${date}`);
}

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/**
 * True when every date lands on (or one day after, for deposits that post a
 * day late) a semi-monthly pay date, and both the mid-month and the
 * end-of-month dates appear. Needs at least three dates.
 */
export function looksSemimonthly(dates: string[]): boolean {
  if (dates.length < 3) return false;
  let mid = false;
  let end = false;
  for (const date of dates) {
    const { year, month } = parse(date);
    const [fifteenth, last] = semimonthlyPayDates(year, month);
    // A late end-of-month deposit can land on the 1st of the next month.
    const previous = month === 1 ? semimonthlyPayDates(year - 1, 12) : semimonthlyPayDates(year, month - 1);
    const near = (anchor: string) => {
      const diff = dayDiff(date, anchor);
      return diff >= 0 && diff <= 1;
    };
    if (near(fifteenth)) mid = true;
    else if (near(last) || near(previous[1])) end = true;
    else return false;
  }
  return mid && end;
}
