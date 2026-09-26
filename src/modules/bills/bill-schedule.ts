/** Internal retired keys preserve historical row IDs without occupying a new schedule's logical slot. */
export const retiredSchedulePrefix = (billId: string) =>
  `${billId}:rescheduled:`;
export const scheduleKey = (billId: string, cadence: string, date: string) =>
  `${billId}:${cadence === "monthly" ? date.slice(0, 7) : date}`;
type ScheduledRow = {
  occurrenceKey: string;
  dueDate: string;
  dueDateOverride: string | null;
  expectedAmountOverrideCents: bigint | null;
  status: string;
  linkedTransactionId: string | null;
  markedPaidAt: Date | null;
};
/** Never create another payment in a protected cycle or on a protected effective/baseline date. */
export function safeScheduleDates(
  billId: string,
  cadence: string,
  today: string,
  dates: string[],
  rows: ScheduledRow[],
): string[] {
  const protectedRows = rows.filter(
    (row) =>
      (row.dueDateOverride ?? row.dueDate) < today ||
      row.dueDateOverride !== null ||
      row.expectedAmountOverrideCents !== null ||
      row.linkedTransactionId !== null ||
      row.markedPaidAt !== null ||
      !["upcoming", "cancelled"].includes(row.status) ||
      (row.status === "cancelled" &&
        !row.occurrenceKey.startsWith(retiredSchedulePrefix(billId))),
  );
  return dates.filter(
    (date) =>
      !protectedRows.some(
        (row) =>
          row.occurrenceKey === scheduleKey(billId, cadence, date) ||
          row.dueDate === date ||
          (row.dueDateOverride ?? row.dueDate) === date,
      ),
  );
}

/** A different logical key cannot insert on a date already held by an older protected cycle. */
export function nonCollidingScheduleDates(
  billId: string,
  cadence: string,
  dates: string[],
  rows: ScheduledRow[],
): string[] {
  return dates.filter(
    (date) =>
      !rows.some(
        (row) =>
          row.occurrenceKey !== scheduleKey(billId, cadence, date) &&
          (row.dueDate === date || row.dueDateOverride === date),
      ),
  );
}
