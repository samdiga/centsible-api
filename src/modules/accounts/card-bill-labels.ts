import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

type NamedAccount = Readonly<{
  id: string;
  name: string;
  nameOverride: string | null;
  mask: string | null;
}>;

/** The account's name as the user sees it. */
export function shownAccountName(account: NamedAccount): string {
  return account.nameOverride ?? account.name;
}

/**
 * "Chase Freedom payment"; "Venture X ••6925 payment" when another of
 * `accounts` shows the same name.
 */
export function cardBillName(
  account: NamedAccount,
  accounts: readonly NamedAccount[],
): string {
  const shown = shownAccountName(account);
  const shared = accounts.some(
    (other) => other.id !== account.id && shownAccountName(other) === shown,
  );
  return `${shared && account.mask ? `${shown} ••${account.mask}` : shown} payment`;
}

/**
 * Names each card and loan's statement bill after the account, through
 * `account_label`, so a rename (the user's or the bank's) renames the bill.
 * The user's own `display_name` still wins; one equal to the label adds
 * nothing and is cleared, so it no longer pins the old name. A card's bill
 * is its live monthly transfer bill (else its oldest kept one), as
 * upsertStatementBills finds it; the index allows one label per account.
 * Lives with accounts because a rename must call it and bills already
 * depends on accounts.
 */
export async function refreshCardBillLabels(
  db: Db | DbTransaction,
  userId: string,
): Promise<void> {
  const accounts = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      nameOverride: schema.accounts.nameOverride,
      mask: schema.accounts.mask,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        isNull(schema.accounts.deletedAt),
        inArray(schema.accounts.type, ["credit", "loan"]),
      ),
    );
  if (!accounts.length) return;
  const bills = await db
    .select({
      id: schema.billSetup.id,
      toAccountId: schema.billSetup.toAccountId,
      status: schema.billSetup.status,
      displayName: schema.billSetup.displayName,
      accountLabel: schema.billSetup.accountLabel,
    })
    .from(schema.billSetup)
    .where(
      and(
        eq(schema.billSetup.userId, userId),
        eq(schema.billSetup.billType, "transfer"),
        eq(schema.billSetup.cadence, "monthly"),
        isNull(schema.billSetup.deletedAt),
        inArray(
          schema.billSetup.toAccountId,
          accounts.map((account) => account.id),
        ),
      ),
    )
    .orderBy(asc(schema.billSetup.createdAt));
  const labelled: { id: string; label: string; displayName: string | null }[] =
    [];
  const cleared: string[] = [];
  for (const account of accounts) {
    const mine = bills.filter((bill) => bill.toAccountId === account.id);
    const bill =
      mine.find((row) => row.status === "active") ?? mine[0];
    if (!bill) continue;
    for (const other of mine)
      if (other !== bill && other.accountLabel !== null) cleared.push(other.id);
    const label = cardBillName(account, accounts);
    if (bill.accountLabel !== label || bill.displayName === label)
      labelled.push({
        id: bill.id,
        label,
        displayName: bill.displayName === label ? null : bill.displayName,
      });
  }
  // Cleared first: the index allows one label per account.
  if (cleared.length)
    await db
      .update(schema.billSetup)
      .set({ accountLabel: null, updatedAt: new Date() })
      .where(inArray(schema.billSetup.id, cleared));
  for (const { id, label, displayName } of labelled)
    await db
      .update(schema.billSetup)
      .set({ accountLabel: label, displayName, updatedAt: new Date() })
      .where(eq(schema.billSetup.id, id));
}
