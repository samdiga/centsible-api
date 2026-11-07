/** The parts of a bill that decide what it is called. */
export type BillNameParts = Readonly<{
  /** The user's own name for the bill. */
  displayName: string | null | undefined;
  /** A card bill's "<account name> payment", kept in step with the account (T-182). */
  accountLabel: string | null | undefined;
  /** The detected name; always set, never shown when either of the above is. */
  canonicalName: string;
}>;

/**
 * What every surface calls a bill: the user's name, else a card bill's
 * account label, else the detected name. Blank values are skipped. One
 * function so the Bills list, Home, the forecast and reminders can't drift.
 */
export function billName(bill: BillNameParts): string {
  if (bill.displayName?.trim()) return bill.displayName;
  if (bill.accountLabel?.trim()) return bill.accountLabel;
  return bill.canonicalName;
}
