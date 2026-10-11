import type { UpcomingBillRow } from "./dashboard.repository.js";

type BillState = Pick<UpcomingBillRow, "status" | "hasPayment">;

/** Marked paid by hand, with no payment at the bank yet ("Payment pending"). */
export const isMarkedPaid = (bill: BillState) =>
  bill.status === "processing" && !bill.hasPayment;

/**
 * The bill's money hasn't left yet, so it still comes out of safe to spend:
 * still to pay, or marked paid by hand until the payment shows up (T-128).
 * A payment attached at the bank (posted or pending) is already in the
 * balance. Rows from getUpcomingBills are never paid, skipped or cancelled.
 */
export const moneyStillToLeave = (bill: BillState) =>
  bill.status !== "processing" || !bill.hasPayment;
