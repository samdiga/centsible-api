import { ValidationError } from "../../platform/errors/app-error.js";

export type ManualAccountSubtype =
  | "cash"
  | "checking"
  | "savings"
  | "credit_card";

/**
 * Manual account balances follow the same convention Plaid uses for credit
 * accounts: the stored balance is always positive and represents the amount
 * owed (debt), never a negative "you're in credit" figure. Every writer of a
 * manual account balance (creation, edits, net worth/dashboard math) must
 * route through this helper so the sign convention never drifts.
 */
export function normalizeManualBalanceCents(
  subtype: ManualAccountSubtype,
  balanceCents: bigint,
): bigint {
  if (subtype === "credit_card" && balanceCents < 0n) {
    throw new ValidationError(
      "Credit card balance must be zero or positive cents (amount owed)",
    );
  }
  return balanceCents;
}

/** True when a manual subtype's stored balance represents debt owed. */
export function isManualDebtSubtype(subtype: ManualAccountSubtype): boolean {
  return subtype === "credit_card";
}
