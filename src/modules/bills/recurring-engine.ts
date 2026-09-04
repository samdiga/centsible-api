export type RecurringCadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "irregular";
export type DetectionTransaction = {
  merchantName: string | null;
  name: string;
  amountCents: bigint;
  date: string;
  isIncome: boolean;
  isTransfer: boolean;
  excludeFromBudgets: boolean;
};
export type ExistingRecurringSeries = {
  id: string;
  canonicalName: string;
  cadence: string;
  status: string;
  avgAmountCents: bigint;
  lastOccurredOn: string | null;
  nextExpectedDate: string | null;
};
export type NewRecurringSeries = {
  canonicalName: string;
  cadence: Exclude<RecurringCadence, "semimonthly" | "irregular">;
  avgAmountCents: bigint;
  stdDevAmountCents: bigint;
  lastAmountCents: bigint;
  lastOccurredOn: string;
  nextExpectedDate: string;
  confidence: number;
  sampleCount: number;
  status: "pending_confirmation";
  isIncome: false;
};
export type RecurringSeriesUpdate = {
  id: string;
  lastOccurredOn: string;
  nextExpectedDate: string;
  lastAmountCents: bigint;
  avgAmountCents: bigint;
  sampleCount: number;
  lastPriceChangeAt?: Date;
  previousAvgAmountCents?: bigint;
};

export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9#\s]/g, " ")
    .replace(/\b(llc|inc|corp|ltd|com)\b/gi, "")
    .replace(/[#0-9]+/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return values.length === 0
    ? 0
    : sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
};
const stdDev = (values: number[], med: number) =>
  values.length < 2
    ? 0
    : Math.sqrt(
        values.reduce((sum, value) => sum + (value - med) ** 2, 0) /
          values.length,
      );
export function classifyCadence(
  intervals: number[],
): Exclude<RecurringCadence, "semimonthly" | "irregular"> | null {
  const med = median(intervals);
  if (!intervals.length) return null;
  if (med >= 6 && med <= 8) return "weekly";
  if (med >= 13 && med <= 15) return "biweekly";
  if (med >= 27 && med <= 32) return "monthly";
  if (med >= 85 && med <= 95) return "quarterly";
  if (med >= 350 && med <= 380) return "annual";
  return null;
}
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const value = new Date(Date.UTC(y, m - 1, d));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function addCalendarMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, lastDay)))
    .toISOString()
    .slice(0, 10);
}
export function nextDateForCadence(
  date: string,
  cadence: Exclude<RecurringCadence, "semimonthly" | "irregular">,
): string {
  switch (cadence) {
    case "weekly":
      return addDays(date, 7);
    case "biweekly":
      return addDays(date, 14);
    case "monthly":
      return addCalendarMonths(date, 1);
    case "quarterly":
      return addCalendarMonths(date, 3);
    case "annual":
      return addCalendarMonths(date, 12);
  }
}
const daysBetween = (a: string, b: string) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
export function detectRecurring(
  transactions: DetectionTransaction[],
  existing: ExistingRecurringSeries[],
): { toInsert: NewRecurringSeries[]; toUpdate: RecurringSeriesUpdate[] } {
  const groups = new Map<string, DetectionTransaction[]>();
  for (const transaction of transactions.filter(
    (item) => !item.isIncome && !item.isTransfer && !item.excludeFromBudgets,
  )) {
    const key = normalizeMerchant(transaction.merchantName ?? transaction.name);
    if (key) groups.set(key, [...(groups.get(key) ?? []), transaction]);
  }
  const existingByKey = new Map(
    existing.map((row) => [
      `${normalizeMerchant(row.canonicalName)}:${row.cadence}`,
      row,
    ]),
  );
  const toInsert: NewRecurringSeries[] = [];
  const toUpdate: RecurringSeriesUpdate[] = [];
  for (const [key, group] of groups) {
    if (group.length < 3) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const intervals = sorted
      .slice(1)
      .map((row, index) => daysBetween(sorted[index]!.date, row.date));
    const cadence = classifyCadence(intervals);
    if (!cadence) continue;
    const amounts = sorted.map((row) => Number(row.amountCents));
    const medAmount = BigInt(Math.round(median(amounts)));
    const intervalMedian = median(intervals);
    const confidence = Math.max(
      0,
      Math.min(
        1,
        1 - stdDev(intervals, intervalMedian) / (intervalMedian || 1),
      ),
    );
    const last = sorted.at(-1)!;
    const nextExpectedDate = nextDateForCadence(last.date, cadence);
    const known = existingByKey.get(`${key}:${cadence}`);
    if (!known) {
      if (confidence >= 0.6)
        toInsert.push({
          canonicalName: key,
          cadence,
          avgAmountCents: medAmount,
          stdDevAmountCents: BigInt(
            Math.round(stdDev(amounts, median(amounts))),
          ),
          lastAmountCents: last.amountCents,
          lastOccurredOn: last.date,
          nextExpectedDate,
          confidence,
          sampleCount: sorted.length,
          status: "pending_confirmation",
          isIncome: false,
        });
    } else if (known.status === "active") {
      const update: RecurringSeriesUpdate = {
        id: known.id,
        lastOccurredOn: last.date,
        nextExpectedDate,
        lastAmountCents: last.amountCents,
        avgAmountCents: medAmount,
        sampleCount: sorted.length,
      };
      if (
        known.avgAmountCents > 0n &&
        Math.abs(Number(medAmount - known.avgAmountCents)) /
          Number(known.avgAmountCents) >
          0.1
      ) {
        update.lastPriceChangeAt = new Date();
        update.previousAvgAmountCents = known.avgAmountCents;
      }
      toUpdate.push(update);
    }
  }
  return { toInsert, toUpdate };
}
