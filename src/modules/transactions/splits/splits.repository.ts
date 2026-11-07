import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { schema } from "../../../platform/database/client.js";
import type { Db, DbTransaction } from "../../../platform/database/types.js";
import {
  derivedCategoryId,
  mergeDuplicateCategories,
  rebalance,
  type SplitLine,
} from "./split-math.js";

/**
 * Persistence for a transaction's category lines (T-186). Every write keeps
 * `transactions.category_id` equal to the lines' derived category and runs
 * inside the caller's database transaction.
 */
type SplitsDb = Db | DbTransaction;
const lines = () => schema.transactionCategorySplits;

/** Lines per transaction id, in position order; ids without lines are absent. */
export async function listSplitLines(
  userId: string,
  transactionIds: readonly string[],
  db: SplitsDb,
): Promise<Map<string, SplitLine[]>> {
  const byTransaction = new Map<string, SplitLine[]>();
  if (transactionIds.length === 0) return byTransaction;
  const rows = await db
    .select()
    .from(lines())
    .where(
      and(
        eq(lines().userId, userId),
        inArray(lines().transactionId, [...transactionIds]),
      ),
    )
    .orderBy(asc(lines().transactionId), asc(lines().position));
  for (const row of rows) {
    const list = byTransaction.get(row.transactionId) ?? [];
    list.push({
      categoryId: row.categoryId,
      amount: row.amount,
      position: row.position,
      isRemainder: row.isRemainder,
    });
    byTransaction.set(row.transactionId, list);
  }
  return byTransaction;
}

/**
 * Replaces a transaction's lines. With two or more lines the transaction
 * takes their derived category as a hand-picked one and is balanced. With
 * none, the lines go and the flag clears; its category_id is left to the
 * caller. Lines must already be valid (validateSplitLines).
 */
export async function replaceSplitLines(
  userId: string,
  transactionId: string,
  next: readonly SplitLine[],
  db: SplitsDb,
): Promise<void> {
  await writeLines(userId, transactionId, next, db);
  if (next.length === 0) {
    await setTransactionSplitState(
      userId,
      transactionId,
      { outOfBalance: false },
      db,
    );
    return;
  }
  await setTransactionSplitState(
    userId,
    transactionId,
    { outOfBalance: false, categoryId: derivedCategoryId(next) },
    db,
  );
}

/**
 * Removes the lines of every listed transaction whose stored category is not
 * `categoryId`: a single category the user picked replaces a split, while an
 * older app re-sending the split's own category leaves it alone.
 */
export async function clearSplitsUnlessCategory(
  userId: string,
  transactionIds: readonly string[],
  categoryId: string | null,
  db: SplitsDb,
): Promise<void> {
  if (transactionIds.length === 0) return;
  const cleared = await db
    .delete(lines())
    .where(
      and(
        eq(lines().userId, userId),
        inArray(lines().transactionId, [...transactionIds]),
        sql`EXISTS (
          SELECT 1 FROM ${schema.transactions}
          WHERE ${schema.transactions.id} = ${lines().transactionId}
            AND ${schema.transactions.categoryId} IS DISTINCT FROM ${categoryId}::uuid
        )`,
      ),
    )
    .returning({ transactionId: lines().transactionId });
  const ids = [...new Set(cleared.map((row) => row.transactionId))];
  if (ids.length > 0)
    await db
      .update(schema.transactions)
      .set({ splitOutOfBalance: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, ids),
        ),
      );
}

/**
 * After the listed transactions' amounts changed (bank sync, manual edit):
 * the remainder line absorbs the change, or the split is flagged out of
 * balance with its lines kept; a flag clears when the lines add up again.
 * Transactions without lines are untouched. Callers hold the row locks.
 */
export async function rebalanceSplits(
  userId: string,
  transactionIds: readonly string[],
  db: SplitsDb,
): Promise<void> {
  const byTransaction = await listSplitLines(userId, transactionIds, db);
  if (byTransaction.size === 0) return;
  const amounts = await db
    .select({ id: schema.transactions.id, amount: schema.transactions.amount })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.id, [...byTransaction.keys()]),
      ),
    );
  for (const { id, amount } of amounts) {
    const current = byTransaction.get(id)!;
    const result = rebalance(current, amount);
    if (result.outOfBalance)
      await setTransactionSplitState(
        userId,
        id,
        { outOfBalance: true, categoryId: derivedCategoryId(current) },
        db,
      );
    else await replaceSplitLines(userId, id, result.lines, db);
  }
}

/**
 * A category's references move from `fromId` to `toId` (null: uncategorised):
 * archive-with-reassign and customising a shared default. Lines move too;
 * lines of one transaction that now share a category merge into one, and a
 * split left with a single line becomes an ordinary transaction in that
 * category. Every affected transaction's category_id is re-derived; an
 * out-of-balance flag is kept (merging doesn't change the lines' total).
 */
export async function moveSplitLineCategory(
  userId: string,
  fromId: string,
  toId: string | null,
  db: SplitsDb,
): Promise<void> {
  const moved = await db
    .update(lines())
    .set({ categoryId: toId })
    .where(and(eq(lines().userId, userId), eq(lines().categoryId, fromId)))
    .returning({ transactionId: lines().transactionId });
  const ids = [...new Set(moved.map((row) => row.transactionId))];
  const byTransaction = await listSplitLines(userId, ids, db);
  for (const [transactionId, current] of byTransaction) {
    const merged = mergeDuplicateCategories(current);
    if (merged.length === 1) {
      await writeLines(userId, transactionId, [], db);
      await setTransactionSplitState(
        userId,
        transactionId,
        { outOfBalance: false, categoryId: merged[0]!.categoryId },
        db,
      );
      continue;
    }
    if (merged.length < current.length)
      await writeLines(userId, transactionId, merged, db);
    await db
      .update(schema.transactions)
      .set({ categoryId: derivedCategoryId(merged), updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.id, transactionId),
        ),
      );
  }
}

async function writeLines(
  userId: string,
  transactionId: string,
  next: readonly SplitLine[],
  db: SplitsDb,
): Promise<void> {
  await db
    .delete(lines())
    .where(
      and(eq(lines().userId, userId), eq(lines().transactionId, transactionId)),
    );
  if (next.length === 0) return;
  await db.insert(lines()).values(
    next.map((line) => ({
      userId,
      transactionId,
      categoryId: line.categoryId,
      amount: line.amount,
      position: line.position,
      isRemainder: line.isRemainder,
    })),
  );
}

async function setTransactionSplitState(
  userId: string,
  transactionId: string,
  state: { outOfBalance: boolean; categoryId?: string | null },
  db: SplitsDb,
): Promise<void> {
  await db
    .update(schema.transactions)
    .set({
      splitOutOfBalance: state.outOfBalance,
      ...(state.categoryId === undefined
        ? {}
        : { categoryId: state.categoryId, userCategoryOverride: true }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.id, transactionId),
      ),
    );
}
