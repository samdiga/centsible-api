export type BillNotificationKind = "upcoming" | "due_today" | "overdue";

export interface BillInput {
  id: string;
  name: string;
  nextExpectedDate: string | null;
  amountCents: bigint;
}

export interface NotificationPrefsInput {
  billReminderDaysAhead: number;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  reminderHour: number;
  timeZone: string;
}

export interface PlannedNotification {
  id: string;
  billId: string;
  kind: BillNotificationKind;
  title: string;
  body: string;
  fireDate: Date;
}

type WallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

function timeZoneParts(date: Date, timeZone: string): WallParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function parseIsoDate(dateStr: string): [number, number, number] | null {
  const match = ISO_DATE.exec(dateStr);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return [year, month, day];
}

function formatIsoDate(date: Date): string {
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(
    date.getUTCMonth() + 1
  )
    .toString()
    .padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}

function addDays(dateStr: string, days: number): string | null {
  const parts = parseIsoDate(dateStr);
  if (!parts || !Number.isSafeInteger(days)) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

function validHour(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

function validDaysAhead(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 30;
}

function zonedWallTime(
  dateStr: string,
  hour: number,
  timeZone: string,
): Date | null {
  const parts = parseIsoDate(dateStr);
  if (!parts || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  let candidate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour));
  for (let i = 0; i < 5; i += 1) {
    const actual = timeZoneParts(candidate, timeZone);
    const deltaMinutes =
      (Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
      ) -
        Date.UTC(parts[0], parts[1] - 1, parts[2], hour)) /
      60_000;
    if (deltaMinutes === 0) {
      // The fixed point can land on either side of a fall-back fold. Walk
      // backwards far enough to select the earliest UTC instant that still
      // represents the requested wall time.
      const requested = {
        year: parts[0],
        month: parts[1],
        day: parts[2],
        hour,
        minute: 0,
      };
      let earliest = candidate;
      for (let minutes = 1; minutes <= 36 * 60; minutes += 1) {
        const earlier = new Date(candidate.getTime() - minutes * 60_000);
        const earlierParts = timeZoneParts(earlier, timeZone);
        if (
          earlierParts.year === requested.year &&
          earlierParts.month === requested.month &&
          earlierParts.day === requested.day &&
          earlierParts.hour === requested.hour &&
          earlierParts.minute === requested.minute
        ) {
          earliest = earlier;
          continue;
        }
        const earlierWall = Date.UTC(
          earlierParts.year,
          earlierParts.month - 1,
          earlierParts.day,
          earlierParts.hour,
          earlierParts.minute,
        );
        const requestedWall = Date.UTC(
          requested.year,
          requested.month - 1,
          requested.day,
          requested.hour,
          requested.minute,
        );
        if (earlierWall < requestedWall) break;
      }
      return earliest;
    }
    candidate = new Date(candidate.getTime() - deltaMinutes * 60_000);
  }
  // A spring-forward gap has no corresponding instant.
  return null;
}

function shiftOutOfQuiet(
  date: Date,
  prefs: NotificationPrefsInput,
): Date | null {
  if (!prefs.quietHoursEnabled) return date;
  const wall = timeZoneParts(date, prefs.timeZone);
  if (!inQuietHours(wall.hour, prefs.quietHoursStart, prefs.quietHoursEnd))
    return date;
  const wallDate = `${wall.year.toString().padStart(4, "0")}-${wall.month
    .toString()
    .padStart(2, "0")}-${wall.day.toString().padStart(2, "0")}`;
  const isOvernightWindow = prefs.quietHoursStart > prefs.quietHoursEnd;
  const targetDate =
    isOvernightWindow && wall.hour >= prefs.quietHoursStart
      ? addDays(wallDate, 1)
      : wallDate;
  if (!targetDate) return null;
  return zonedWallTime(targetDate, prefs.quietHoursEnd, prefs.timeZone);
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const dollars = absolute / 100n;
  const remainder = (absolute % 100n).toString().padStart(2, "0");
  const groupedDollars = new Intl.NumberFormat("en-US").format(dollars);
  return `${sign}$${groupedDollars}.${remainder}`;
}

export type NextReminderInput = Readonly<{
  dueDate: string | null;
  daysAhead: number;
  timezone: string;
  reminderHour?: number;
}>;

/** Returns a future reminder instant for a local calendar due date. */
export function nextReminder(input: NextReminderInput): Date | null {
  if (!validDaysAhead(input.daysAhead)) return null;
  if (input.reminderHour !== undefined && !validHour(input.reminderHour))
    return null;
  const reminderDate = addDays(input.dueDate ?? "", -input.daysAhead);
  if (!reminderDate) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format();
    return zonedWallTime(reminderDate, input.reminderHour ?? 9, input.timezone);
  } catch {
    return null;
  }
}

export function computeBillNotifications(
  bill: BillInput,
  prefs: NotificationPrefsInput,
  now: Date,
): PlannedNotification[] {
  if (!bill.nextExpectedDate || !parseIsoDate(bill.nextExpectedDate)) return [];
  if (!validDaysAhead(prefs.billReminderDaysAhead)) return [];
  if (
    !validHour(prefs.reminderHour) ||
    !validHour(prefs.quietHoursStart) ||
    !validHour(prefs.quietHoursEnd)
  )
    return [];

  // Constructing this formatter up front both validates the zone and avoids
  // turning a malformed scheduler input into a process-level exception.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: prefs.timeZone }).format(now);
  } catch {
    return [];
  }

  const plans: PlannedNotification[] = [];
  const push = (
    kind: BillNotificationKind,
    fireDateStr: string | null,
    body: string,
  ) => {
    if (!fireDateStr) return;
    const wallTime = zonedWallTime(
      fireDateStr,
      prefs.reminderHour,
      prefs.timeZone,
    );
    if (!wallTime) return;
    const fireDate = shiftOutOfQuiet(wallTime, prefs);
    if (!fireDate || fireDate.getTime() <= now.getTime()) return;
    plans.push({
      id: `${bill.id}:${kind}`,
      billId: bill.id,
      kind,
      title: bill.name,
      body,
      fireDate,
    });
  };

  push(
    "upcoming",
    addDays(bill.nextExpectedDate, -prefs.billReminderDaysAhead),
    `${bill.name} is coming up — ${formatCents(bill.amountCents)} on ${bill.nextExpectedDate}`,
  );
  push(
    "due_today",
    bill.nextExpectedDate,
    `${bill.name} is due today — ${formatCents(bill.amountCents)}`,
  );
  push(
    "overdue",
    addDays(bill.nextExpectedDate, 1),
    `${bill.name} was due ${bill.nextExpectedDate} — ${formatCents(bill.amountCents)}`,
  );
  return plans;
}
