/**
 * Read-only audit: lists bill occurrences already linked (paid or
 * processing) to a transaction that the current auto-match rule would not
 * link: wrong Paid-from account, merchant that does not match the bill, or a
 * card purchase on a card-payment bill. Writes nothing; unlinking is a
 * separate, user-approved step.
 *
 *   PLAID_ACTIVE_ENV=production tsx --env-file=.env scripts/audit-bill-matches.ts
 *
 * Prints the bank's cleaned merchant name, never the raw transaction name.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { loadEnv } from "../src/platform/config/env.js";
import { closeDb, getDb, schema } from "../src/platform/database/client.js";
import { billPayeeMismatch } from "../src/modules/bills/merchant-match.js";
import { billsRepository } from "../src/modules/bills/bills.repository.js";

const dayOffset = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};
const dollars = (cents: bigint | null) =>
  cents === null ? "-" : `$${(Number(cents) / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const environment = loadEnv();
  const db = getDb();
  console.log(`DRY RUN (read-only) against ${environment.PLAID_ACTIVE_ENV}`);

  const paidFrom = alias(schema.accounts, "paid_from");
  const rows = await db
    .select({
      occurrenceId: schema.billOccurrences.id,
      status: schema.billOccurrences.status,
      dueDate: schema.billOccurrences.dueDate,
      billName: sql<string>`coalesce(${schema.billSetup.displayName}, ${schema.billSetup.canonicalName})`,
      billPaidFrom: paidFrom.name,
      setup: {
        accountId: schema.billSetup.accountId,
        billType: schema.billSetup.billType,
        canonicalName: schema.billSetup.canonicalName,
        displayName: schema.billSetup.displayName,
        merchantPatterns: schema.billSetup.merchantPatterns,
      },
      userId: schema.billOccurrences.userId,
      toAccountId: schema.billSetup.toAccountId,
      transactionId: schema.transactions.id,
      transactionDate: schema.transactions.date,
      amount: schema.transactions.amount,
      accountId: schema.transactions.accountId,
      accountName: schema.accounts.name,
      isCard: sql<boolean>`${schema.accounts.type} = 'credit'`,
      merchantName: schema.transactions.merchantName,
      name: schema.transactions.name,
    })
    .from(schema.billOccurrences)
    .innerJoin(
      schema.billSetup,
      eq(schema.billSetup.id, schema.billOccurrences.billSetupId),
    )
    .innerJoin(
      schema.transactions,
      or(
        eq(schema.transactions.id, schema.billOccurrences.linkedTransactionId),
        eq(schema.transactions.id, schema.billOccurrences.pendingTransactionId),
      ),
    )
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.transactions.accountId),
    )
    .leftJoin(paidFrom, eq(paidFrom.id, schema.billSetup.accountId))
    .where(
      and(
        inArray(schema.billOccurrences.status, ["paid", "processing"]),
        isNull(schema.billSetup.deletedAt),
        sql`${schema.billOccurrences.expectedAmountCents} > 0`,
      ),
    )
    .orderBy(schema.billOccurrences.dueDate);

  const payeeNames = new Map<string, string[]>();
  const inflows = new Map<string, Array<{ date: string; amount: bigint }>>();
  for (const userId of new Set(rows.map((row) => row.userId))) {
    const mine = rows.filter(
      (row) =>
        row.userId === userId &&
        row.setup.billType === "transfer" &&
        row.toAccountId,
    );
    const accountIds = [...new Set(mine.map((row) => row.toAccountId!))];
    for (const [
      accountId,
      names,
    ] of await billsRepository.listAccountPayeeNames(userId, accountIds, db))
      payeeNames.set(accountId, names);
    if (!mine.length) continue;
    const dates = mine.map((row) => row.transactionDate).sort();
    for (const inflow of await billsRepository.listAccountInflows(
      userId,
      accountIds,
      dayOffset(dates[0]!, -5),
      dayOffset(dates.at(-1)!, 5),
      db,
    ))
      inflows.set(inflow.accountId, [
        ...(inflows.get(inflow.accountId) ?? []),
        inflow,
      ]);
  }

  const failing = rows.flatMap((row) => {
    const reason = billPayeeMismatch(
      {
        ...row.setup,
        payeeNames: row.toAccountId ? payeeNames.get(row.toAccountId) : [],
        toAccountInflows: row.toAccountId ? inflows.get(row.toAccountId) : [],
      },
      { ...row, date: row.transactionDate },
    );
    return reason ? [{ ...row, reason }] : [];
  });
  console.log(
    `${rows.length} linked occurrences checked; ${failing.length} fail the rule.`,
  );
  for (const row of failing)
    console.log(
      [
        row.reason.padEnd(16),
        row.occurrenceId,
        row.status.padEnd(10),
        `due ${row.dueDate}`,
        `bill "${row.billName}"`,
        `paid from ${row.billPaidFrom ?? "(any)"}`,
        `-> ${row.transactionDate} ${dollars(row.amount)}`,
        `on ${row.accountName}`,
        `merchant ${row.merchantName ?? "(none)"}`,
      ].join(" | "),
    );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
