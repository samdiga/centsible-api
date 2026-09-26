import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { bankCategoryTarget } from "./bank-category-mapping.js";

type AutoDb = Db | DbTransaction;

/** A freshly imported transaction that no rule has categorised. */
export type UncategorisedTransaction = Readonly<{
  id: string;
  merchantName: string | null;
  name: string;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
}>;

export type AutoCategorizeResult = Readonly<{
  fromHistory: number;
  fromBank: number;
}>;

/** How a transaction is recognised as "the same merchant" as an earlier one. */
export function merchantKey(row: {
  merchantName: string | null;
  name: string;
}): string {
  return (row.merchantName?.trim() || row.name.trim()).toLowerCase();
}

/**
 * Assigns categories to new transactions that rules didn't categorise, in the
 * user's chosen order: their own most recent choice for the same merchant,
 * then the bank's category mapped onto their categories by name. Anything
 * with neither stays uncategorised. user_category_override stays false, so a
 * later user choice (or rule) still wins.
 */
export async function autoCategorize(
  userId: string,
  rows: ReadonlyArray<UncategorisedTransaction>,
  db: AutoDb,
): Promise<AutoCategorizeResult> {
  if (rows.length === 0) return { fromHistory: 0, fromBank: 0 };

  const keys = [...new Set(rows.map(merchantKey))];
  const keyExpr = sql<string>`lower(coalesce(nullif(trim(${schema.transactions.merchantName}), ''), trim(${schema.transactions.name})))`;
  const history = await db
    .selectDistinctOn([keyExpr], {
      key: keyExpr,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        isNull(schema.transactions.deletedAt),
        eq(schema.transactions.userCategoryOverride, true),
        isNotNull(schema.transactions.categoryId),
        inArray(keyExpr, keys),
      ),
    )
    .orderBy(
      keyExpr,
      desc(schema.transactions.date),
      desc(schema.transactions.updatedAt),
    );
  const byMerchant = new Map(history.map((row) => [row.key, row.categoryId!]));

  const categories = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
    })
    .from(schema.categories)
    .where(
      and(
        or(
          eq(schema.categories.userId, userId),
          isNull(schema.categories.userId),
        ),
        isNull(schema.categories.archivedAt),
      ),
    );
  const parents = new Map(
    categories.filter((c) => c.parentId === null).map((c) => [c.name, c.id]),
  );
  const children = new Map(
    categories
      .filter((c) => c.parentId !== null)
      .map((c) => [`${c.parentId}|${c.name}`, c.id]),
  );
  const fromBankCategory = (row: UncategorisedTransaction): string | null => {
    const target = bankCategoryTarget(
      row.plaidCategoryPrimary,
      row.plaidCategoryDetailed,
    );
    if (!target) return null;
    const parentId = parents.get(target.parent);
    if (!parentId) return null;
    return (
      (target.child && children.get(`${parentId}|${target.child}`)) || parentId
    );
  };

  let fromHistory = 0;
  let fromBank = 0;
  for (const row of rows) {
    const remembered = byMerchant.get(merchantKey(row));
    const categoryId = remembered ?? fromBankCategory(row);
    if (!categoryId) continue;
    const updated = await db
      .update(schema.transactions)
      .set({ categoryId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.id, row.id),
          eq(schema.transactions.userId, userId),
          isNull(schema.transactions.categoryId),
          eq(schema.transactions.userCategoryOverride, false),
        ),
      )
      .returning({ id: schema.transactions.id });
    if (updated.length === 0) continue;
    if (remembered) fromHistory += 1;
    else fromBank += 1;
  }
  return { fromHistory, fromBank };
}

/** Sync-facing port: find which Plaid ids already existed, then categorise. */
export type TransactionCategorizer = Readonly<{
  existingPlaidIds: (
    plaidTransactionIds: ReadonlyArray<string>,
    userId: string,
    db: AutoDb,
  ) => Promise<Set<string>>;
  categorize: (
    userId: string,
    rows: ReadonlyArray<UncategorisedTransaction>,
    db: AutoDb,
  ) => Promise<AutoCategorizeResult>;
}>;

export const transactionCategorizer: TransactionCategorizer = {
  async existingPlaidIds(ids, userId, db) {
    if (ids.length === 0) return new Set();
    const rows = await db
      .select({ id: schema.transactions.plaidTransactionId })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.plaidTransactionId, [...ids]),
        ),
      );
    return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
  },
  categorize: autoCategorize,
};
