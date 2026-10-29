import { and, gt, inArray, sql } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

/**
 * A card's statement worked out from its statement day and payment due day,
 * for links that don't supply one (Transactions-only, no Plaid Liabilities),
 * and for a bank statement gone stale: its due date has passed and a later
 * statement day has too, but the bank hasn't sent the newer statement. A
 * current bank statement always wins.
 *
 * Statement balance = what's owed now minus everything posted since the
 * statement day: charges after the close added to the debt, payments and
 * credits after it took from it.
 */
export type DerivedStatement = Readonly<{
  statementDate: string;
  paymentDueDate: string;
  /** Null when the card has no current balance to work from. */
  statementBalance: bigint | null;
}>;

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** `day` in that month, moved back to the month's last day when short. */
const onDay = (year: number, month: number, day: number) => {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const y = normalized.getUTCFullYear();
  const m = normalized.getUTCMonth() + 1;
  const d = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** The most recent statement day on or before `today`. */
export function lastStatementDate(statementDay: number, today: string): string {
  const [year, month] = today.split("-").map(Number) as [number, number];
  const thisMonth = onDay(year, month, statementDay);
  return thisMonth <= today ? thisMonth : onDay(year, month - 1, statementDay);
}

/** The first payment due day after the statement date. */
export function dueDateAfter(
  statementDate: string,
  paymentDueDay: number,
): string {
  const [year, month] = statementDate.split("-").map(Number) as [
    number,
    number,
  ];
  const sameMonth = onDay(year, month, paymentDueDay);
  return sameMonth > statementDate
    ? sameMonth
    : onDay(year, month + 1, paymentDueDay);
}

export function deriveStatement(
  input: Readonly<{
    statementDay: number;
    paymentDueDay: number;
    currentBalance: bigint | null;
    /** Net of the card's posted transactions dated after the statement date. */
    postedSinceStatement: bigint;
  }>,
  today: string,
): DerivedStatement {
  const statementDate = lastStatementDate(input.statementDay, today);
  return {
    statementDate,
    paymentDueDate: dueDateAfter(statementDate, input.paymentDueDay),
    statementBalance:
      input.currentBalance === null
        ? null
        : input.currentBalance - input.postedSinceStatement,
  };
}

type CardRow = Readonly<{
  id: string;
  type: string;
  currentBalance: bigint | null;
  statementBalance: bigint | null;
  statementDate: string | null;
  paymentDueDate: string | null;
  statementDay: number | null;
  paymentDueDay: number | null;
}>;

const dayOf = (date: string | null) => (date ? Number(date.slice(-2)) : null);

/**
 * The statement and due days to work from: the user's, else the days of the
 * bank's last statement, so a card with a stale statement keeps its cycle.
 */
const cycleDays = (row: CardRow) => ({
  statementDay: row.statementDay ?? dayOf(row.statementDate),
  paymentDueDay: row.paymentDueDay ?? dayOf(row.paymentDueDate),
});

/** Whether the card's statement figures will be worked out from its days. */
const derivable = (row: CardRow, today: string) => {
  if (row.type !== "credit") return false;
  if (row.statementDate == null && row.statementBalance == null)
    return row.statementDay != null && row.paymentDueDay != null;
  const days = cycleDays(row);
  return (
    row.paymentDueDate != null &&
    row.paymentDueDate < today &&
    days.statementDay != null &&
    days.paymentDueDay != null &&
    // Only once a statement day after the bank's has passed: until then the
    // bank's statement is still the latest one.
    (row.statementDate == null ||
      lastStatementDate(days.statementDay, today) > row.statementDate)
  );
};

/**
 * Fills in statementDate, paymentDueDate and statementBalance for cards
 * whose statement is worked out from their days (see `derivable`), and marks
 * them `statementDerived`. Other rows pass through unchanged.
 */
export async function withDerivedStatements<Row extends CardRow>(
  db: Db | DbTransaction,
  userId: string,
  rows: ReadonlyArray<Row>,
  today: string,
): Promise<Array<Row & { statementDerived: boolean }>> {
  const cards = rows.filter((row) => derivable(row, today));
  if (cards.length === 0)
    return rows.map((row) => ({ ...row, statementDerived: false }));
  const closes = new Map(
    cards.map((row) => [
      row.id,
      lastStatementDate(cycleDays(row).statementDay!, today),
    ]),
  );
  const earliest = [...closes.values()].sort()[0]!;
  const posted = await db
    .select({
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
    })
    .from(schema.transactions)
    .where(
      and(
        sql`${schema.transactions.userId} = ${userId}`,
        inArray(
          schema.transactions.accountId,
          cards.map((row) => row.id),
        ),
        sql`${schema.transactions.status} = 'posted'`,
        sql`${schema.transactions.deletedAt} IS NULL`,
        gt(schema.transactions.date, earliest),
        sql`${schema.transactions.date} <= ${today}`,
      ),
    );
  return rows.map((row) => {
    if (!derivable(row, today)) return { ...row, statementDerived: false };
    const days = cycleDays(row);
    const close = closes.get(row.id)!;
    const since = posted
      .filter((t) => t.accountId === row.id && t.date > close)
      .reduce((sum, t) => sum + t.amount, 0n);
    const statement = deriveStatement(
      {
        statementDay: days.statementDay!,
        paymentDueDay: days.paymentDueDay!,
        currentBalance: row.currentBalance,
        postedSinceStatement: since,
      },
      today,
    );
    return { ...row, ...statement, statementDerived: true };
  });
}
