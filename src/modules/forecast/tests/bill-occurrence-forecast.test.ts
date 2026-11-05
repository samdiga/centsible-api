import { expect, it } from "vitest";
import {
  isUnlinkedManualPayment,
  suppressBillForecast,
} from "../bill-occurrence-forecast.js";

const occurrence = (fields: Record<string, unknown>) =>
  ({
    status: "processing",
    pendingTransactionId: null,
    linkedTransactionId: null,
    dueDate: "2026-10-14",
    dueDateOverride: null,
    paidAmountCents: 100000n,
    expectedAmountOverrideCents: null,
    expectedAmountCents: 1150000n,
    confirmedPaidAt: null,
    ...fields,
  }) as Parameters<typeof suppressBillForecast>[0];

it.each([
  ["marked paid, waiting for its payment", {}, false, true],
  [
    "closed as marked after the wait",
    { status: "paid", confirmedPaidAt: new Date("2026-10-24T00:00:00Z") },
    true,
    false,
  ],
  [
    "paid against its payment",
    { status: "paid", linkedTransactionId: "t-1", confirmedPaidAt: new Date() },
    true,
    false,
  ],
])("%s: suppressed %s, still to leave %s", (_label, fields, suppressed, pending) => {
  expect(suppressBillForecast(occurrence(fields))).toBe(suppressed);
  expect(isUnlinkedManualPayment(occurrence(fields))).toBe(pending);
});
