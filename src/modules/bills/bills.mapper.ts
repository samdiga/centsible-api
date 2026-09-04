import type { BillOccurrenceRow } from "./bill-occurrences.repository.js";
import type { BillRow } from "./bills.repository.js";
import type { BillDto, BillOccurrenceDto } from "./bills.schemas.js";

export function toBillOccurrenceDto(row: BillOccurrenceRow): BillOccurrenceDto {
  return {
    id: row.id,
    billSetupId: row.billSetupId,
    dueDate: row.dueDate,
    status: row.status,
    expectedAmountCents: row.expectedAmountCents.toString(),
    paidAmountCents: row.paidAmountCents?.toString() ?? null,
    paidAccountId: row.paidAccountId,
    linkedTransactionId: row.linkedTransactionId,
    markedPaidAt: row.markedPaidAt?.toISOString() ?? null,
    confirmedPaidAt: row.confirmedPaidAt?.toISOString() ?? null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toBillDto(
  row: BillRow,
  currentOccurrence?: BillOccurrenceRow | null,
): BillDto {
  return {
    id: row.id,
    canonicalName: row.canonicalName,
    cadence: row.cadence,
    status: row.status,
    avgAmountCents: row.avgAmount.toString(),
    lastAmountCents: row.lastAmount?.toString() ?? null,
    nextExpectedDate: row.nextExpectedDate,
    lastOccurredOn: row.lastOccurredOn,
    categoryId: row.categoryId,
    billType: row.billType,
    accountId: row.accountId,
    toAccountId: row.toAccountId,
    confidence: row.confidence,
    sampleCount: row.sampleCount,
    userConfirmed: row.userConfirmed,
    lastPriceChangeAt: row.lastPriceChangeAt?.toISOString() ?? null,
    previousAvgAmountCents: row.previousAvgAmount?.toString() ?? null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    currentOccurrence: currentOccurrence
      ? toBillOccurrenceDto(currentOccurrence)
      : null,
  };
}
