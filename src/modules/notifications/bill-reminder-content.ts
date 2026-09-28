/**
 * The daily bill-reminder push: one notification per user per local day,
 * worded like the app's local reminders (T-097) so they read the same.
 * Pure: occurrences and dates in, text out.
 */

export type ReminderOccurrence = Readonly<{
  occurrenceId: string;
  name: string;
  /** Effective due date, `YYYY-MM-DD`. */
  dueDate: string;
  /** Effective expected amount; outflows are positive (Plaid sign). */
  amountCents: bigint;
}>;

export type BillReminderContent = Readonly<{
  title: string;
  body: string;
  /** First day of the month the push opens Bills on, `YYYY-MM-01`. */
  month: string;
  dueOccurrenceIds: string[];
  overdueOccurrenceIds: string[];
}>;

export type BillReminderInput = Readonly<{
  /** The user's local date the reminder is for, `YYYY-MM-DD`. */
  localDate: string;
  daysAhead: number;
  hideAmounts: boolean;
  /** Unpaid, non-income occurrences for the user. */
  occurrences: readonly ReminderOccurrence[];
  /** Occurrences earlier reminders already named, as due or as overdue. */
  mentioned: MentionedOccurrences;
}>;

export type MentionedOccurrences = Readonly<{
  due: ReadonlySet<string>;
  overdue: ReadonlySet<string>;
}>;

const DAY_MS = 86_400_000;

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/**
 * Bills due between today and `daysAhead` days out that no reminder has
 * mentioned yet (so a bill added inside its lead time still gets one), plus
 * each overdue bill once. Nothing to say means no push.
 */
export function buildBillReminder(
  input: BillReminderInput,
): BillReminderContent | null {
  const today = dayNumber(input.localDate);
  // A bill is named once as due and, if it goes unpaid, once as overdue.
  const bills = input.occurrences.filter((row) => row.amountCents > 0n);
  const due = bills.filter((row) => {
    const days = dayNumber(row.dueDate) - today;
    return (
      days >= 0 &&
      days <= input.daysAhead &&
      !input.mentioned.due.has(row.occurrenceId)
    );
  });
  const overdue = bills.filter(
    (row) =>
      dayNumber(row.dueDate) < today &&
      !input.mentioned.overdue.has(row.occurrenceId),
  );
  if (!due.length && !overdue.length) return null;

  const dueDates = [...new Set(due.map((row) => row.dueDate))].sort();
  const lines = dueDates.map((date) =>
    dueLine(
      due.filter((row) => row.dueDate === date),
      date,
      input.hideAmounts,
    ),
  );
  if (overdue.length)
    lines.push(`${overdue.length} overdue: ${names(overdue)}.`);

  const opens =
    dueDates[0] ??
    overdue.map((row) => row.dueDate).sort()[0] ??
    input.localDate;
  return {
    title: title(due, dueDates, overdue.length, input.localDate),
    body: lines.join("\n"),
    month: `${opens.slice(0, 7)}-01`,
    dueOccurrenceIds: due.map((row) => row.occurrenceId),
    overdueOccurrenceIds: overdue.map((row) => row.occurrenceId),
  };
}

/** `Rent is due tomorrow` · `3 bills are due in 3 days` · `2 bills are overdue` */
function title(
  due: readonly ReminderOccurrence[],
  dueDates: readonly string[],
  overdueCount: number,
  localDate: string,
): string {
  const first = dueDates[0];
  if (!first)
    return overdueCount === 1
      ? "1 bill is overdue"
      : `${overdueCount} bills are overdue`;
  if (dueDates.length > 1) return `${due.length} bills are due soon`;
  const phrase = duePhrase(dayNumber(first) - dayNumber(localDate));
  return due.length === 1
    ? `${due[0]!.name} is ${phrase}`
    : `${due.length} bills are ${phrase}`;
}

/**
 * `Rent $1,850 is due Thu, Oct 1.`
 * `3 bills due Thu, Oct 1: Rent, Geico, PSE&G · $2,641 total.`
 */
function dueLine(
  rows: readonly ReminderOccurrence[],
  date: string,
  hideAmounts: boolean,
): string {
  const when = mediumDate(date);
  if (rows.length === 1) {
    const row = rows[0]!;
    return hideAmounts
      ? `${row.name} is due ${when}.`
      : `${row.name} ${wholeDollars(row.amountCents)} is due ${when}.`;
  }
  const list = `${rows.length} bills due ${when}: ${names(rows)}`;
  if (hideAmounts) return `${list}.`;
  const total = rows.reduce((sum, row) => sum + row.amountCents, 0n);
  return `${list} · ${wholeDollars(total)} total.`;
}

const names = (rows: readonly ReminderOccurrence[]) =>
  rows.map((row) => row.name).join(", ");

function duePhrase(daysOut: number): string {
  if (daysOut <= 0) return "due today";
  if (daysOut === 1) return "due tomorrow";
  return `due in ${daysOut} days`;
}

/** `Thu, Oct 1`: the calendar date as sent, never shifted by a zone. */
function mediumDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Whole dollars, rounded toward zero, as the app's running copy does. */
function wholeDollars(cents: bigint): string {
  const dollars = (cents < 0n ? -cents : cents) / 100n;
  return `$${new Intl.NumberFormat("en-US").format(dollars)}`;
}

/** The app capitalises lowercase detected names (`pse g` -> `Pse G`). */
export function billDisplayName(
  displayName: string | null,
  canonicalName: string,
): string {
  if (displayName?.trim()) return displayName;
  const name = canonicalName.trim();
  return name === name.toLowerCase()
    ? name.replace(
        /(^|\s)(\S)/g,
        (_, space: string, letter: string) => `${space}${letter.toUpperCase()}`,
      )
    : name;
}
