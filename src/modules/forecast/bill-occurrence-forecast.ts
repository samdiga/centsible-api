import type { BillOccurrenceRow } from "../bills/bill-occurrences.repository.js";

type ForecastOccurrence = Pick<
  BillOccurrenceRow,
  | "status"
  | "pendingTransactionId"
  | "linkedTransactionId"
  | "dueDate"
  | "dueDateOverride"
  | "paidAmountCents"
  | "expectedAmountOverrideCents"
  | "expectedAmountCents"
>;

/** A hand-recorded payment has not reached an account balance yet. */
export function isUnlinkedManualPayment(
  occurrence: ForecastOccurrence,
): boolean {
  return (
    (occurrence.status === "processing" || occurrence.status === "paid") &&
    occurrence.pendingTransactionId === null &&
    occurrence.linkedTransactionId === null
  );
}

export function suppressBillForecast(occurrence: ForecastOccurrence): boolean {
  return (
    occurrence.status === "skipped" ||
    occurrence.status === "cancelled" ||
    occurrence.pendingTransactionId !== null ||
    occurrence.linkedTransactionId !== null
  );
}

export function manualPaymentDate(
  occurrence: ForecastOccurrence,
  today: string,
): string {
  const due = occurrence.dueDateOverride ?? occurrence.dueDate;
  return due < today ? today : due;
}

export function manualPaymentAmount(occurrence: ForecastOccurrence): bigint {
  return (
    occurrence.paidAmountCents ??
    occurrence.expectedAmountOverrideCents ??
    occurrence.expectedAmountCents
  );
}
