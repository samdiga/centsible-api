import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { billsRepository } from "./bills.repository.js";
import { normalizeMerchant } from "./recurring-engine.js";

type Payment = Readonly<{
  accountId: string;
  accountType: string;
  date: string;
  amount: bigint;
  recurringSeriesId: string | null;
  merchantKey: string;
  isTransfer: boolean;
  currency: string;
}>;
export type PaidFromProposal = Readonly<{
  billId: string;
  accountId: string;
  votes: number;
  samples: number;
}>;

/** A unique plurality; equal leading counts deliberately produce no choice. */
export function majorityAccount(
  ids: readonly string[],
): Omit<PaidFromProposal, "billId"> | null {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0];
  if (!winner || winner[1] === ranked[1]?.[1]) return null;
  return { accountId: winner[0], votes: winner[1], samples: ids.length };
}

export function inferBillAccount(
  bill: Pick<
    typeof schema.billSetup.$inferSelect,
    | "id"
    | "canonicalName"
    | "merchantPatterns"
    | "billType"
    | "toAccountId"
    | "isIncome"
  >,
  payments: readonly Payment[],
  creditAccountIds: ReadonlySet<string>,
): PaidFromProposal | null {
  let votes: string[];
  if (bill.billType === "transfer") {
    if (!bill.toAccountId || !creditAccountIds.has(bill.toAccountId))
      return null;
    const outflows = payments.filter(
      (p) => p.accountType === "depository" && p.amount > 0n,
    );
    votes = payments
      .filter((p) => p.accountId === bill.toAccountId && p.amount < 0n)
      .flatMap((inflow) => {
        const matches = new Set(
          outflows
            .filter((outflow) => {
              const difference = outflow.amount + inflow.amount;
              return (
                outflow.currency === inflow.currency &&
                difference >= -100n &&
                difference <= 100n &&
                Math.abs(Date.parse(outflow.date) - Date.parse(inflow.date)) <=
                  3 * 86_400_000
              );
            })
            .map((p) => p.accountId),
        );
        // A category identifies a payment, but cannot identify its source without a match.
        return matches.size === 1 ? [...matches] : [];
      });
  } else {
    const keys = new Set(
      [bill.canonicalName, ...bill.merchantPatterns]
        .map(normalizeMerchant)
        .filter(Boolean),
    );
    votes = payments
      .filter((p) => {
        if (p.amount === 0n || p.amount < 0n !== bill.isIncome) return false;
        if (p.recurringSeriesId) return p.recurringSeriesId === bill.id;
        return !p.isTransfer && keys.has(p.merchantKey);
      })
      .map((p) => p.accountId);
  }
  const winner = majorityAccount(votes);
  return winner ? { billId: bill.id, ...winner } : null;
}

/** Preview uses the same evidence and rules as the transactional write path. */
export async function previewPaidFrom(
  userId: string,
  db: Db | DbTransaction,
  today = new Date().toISOString().slice(0, 10),
  lock = false,
): Promise<PaidFromProposal[]> {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 180);
  const billsQuery = db
    .select()
    .from(schema.billSetup)
    .where(
      and(
        eq(schema.billSetup.userId, userId),
        isNull(schema.billSetup.deletedAt),
        isNull(schema.billSetup.accountId),
        eq(schema.billSetup.paidFromExternal, false),
        inArray(schema.billSetup.status, [
          "active",
          "pending_confirmation",
          "paused",
        ]),
      ),
    );
  const bills = await (lock ? billsQuery.for("update") : billsQuery);
  if (!bills.length) return [];
  const accounts = await db
    .select({ id: schema.accounts.id, type: schema.accounts.type })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        isNull(schema.accounts.deletedAt),
        isNull(schema.accounts.archivedAt),
        inArray(schema.accounts.type, ["depository", "credit"]),
      ),
    );
  const rows = await db
    .select({
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      recurringSeriesId: schema.transactions.recurringSeriesId,
      merchantName: schema.transactions.merchantName,
      name: schema.transactions.name,
      currency: schema.transactions.currency,
      isTransfer: schema.categories.isTransfer,
      plaidCategory: schema.transactions.plaidCategoryDetailed,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(
      and(
        eq(schema.transactions.userId, userId),
        isNull(schema.transactions.deletedAt),
        eq(schema.transactions.status, "posted"),
        isNull(schema.transactions.parentTransactionId),
        isNull(schema.transactions.isDuplicateOf),
        gte(schema.transactions.date, cutoff.toISOString().slice(0, 10)),
        lte(schema.transactions.date, today),
      ),
    );
  const accountTypes = new Map(accounts.map((a) => [a.id, a.type]));
  const payments: Payment[] = rows.flatMap((row) => {
    const accountType = accountTypes.get(row.accountId);
    return accountType
      ? [
          {
            ...row,
            accountType,
            merchantKey: normalizeMerchant(row.merchantName ?? row.name),
            isTransfer:
              row.isTransfer === true ||
              row.plaidCategory === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
          },
        ]
      : [];
  });
  const credits = new Set(
    accounts.filter((a) => a.type === "credit").map((a) => a.id),
  );
  return bills.flatMap((bill) => {
    const proposal = inferBillAccount(bill, payments, credits);
    return proposal ? [proposal] : [];
  });
}

/** Caller owns withUserMutation, so inference, audit and revision commit together. */
export async function inferPaidFromInMutation(
  userId: string,
  tx: DbTransaction,
  today?: string,
  approved?: readonly PaidFromProposal[],
): Promise<PaidFromProposal[]> {
  const proposals = await previewPaidFrom(userId, tx, today, true);
  if (approved) {
    const assignments = (rows: readonly PaidFromProposal[]) =>
      rows
        .map((row) => `${row.billId}:${row.accountId}`)
        .sort()
        .join("\n");
    if (assignments(proposals) !== assignments(approved))
      throw new Error(
        "Paid-from evidence changed; review a fresh proposal before applying.",
      );
  }
  const applied: PaidFromProposal[] = [];
  for (const proposal of proposals) {
    const [updated] = await tx
      .update(schema.billSetup)
      .set({ accountId: proposal.accountId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          eq(schema.billSetup.id, proposal.billId),
          isNull(schema.billSetup.accountId),
          eq(schema.billSetup.paidFromExternal, false),
          isNull(schema.billSetup.deletedAt),
        ),
      )
      .returning({ id: schema.billSetup.id });
    if (!updated) continue;
    await billsRepository.recordAudit(
      {
        userId,
        entityType: "bill_setup",
        entityId: proposal.billId,
        action: "update",
        source: "system",
        before: { accountId: null },
        after: {
          accountId: proposal.accountId,
          inference: { votes: proposal.votes, samples: proposal.samples },
        },
      },
      tx,
    );
    applied.push(proposal);
  }
  return applied;
}
