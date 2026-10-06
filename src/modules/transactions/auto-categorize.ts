import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { bankCategoryTarget } from "./bank-category-mapping.js";

type AutoDb = Db | DbTransaction;

/** A synced transaction that neither the user nor a rule has categorised. */
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

/** One decision: the category a transaction would get, and why. */
export type PlannedCategory = Readonly<{
  transactionId: string;
  categoryId: string;
  source: "history" | "bank";
}>;

/** How a transaction is recognised as "the same merchant" as an earlier one. */
export function merchantKey(row: {
  merchantName: string | null;
  name: string;
}): string {
  return (row.merchantName?.trim() || row.name.trim()).toLowerCase();
}

/**
 * Assigns categories to transactions that rules didn't categorise, in the
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
  let fromHistory = 0;
  let fromBank = 0;
  for (const plan of await planAutoCategories(userId, rows, db)) {
    const updated = await db
      .update(schema.transactions)
      .set({ categoryId: plan.categoryId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.id, plan.transactionId),
          eq(schema.transactions.userId, userId),
          isNull(schema.transactions.categoryId),
          eq(schema.transactions.userCategoryOverride, false),
        ),
      )
      .returning({ id: schema.transactions.id });
    if (updated.length === 0) continue;
    if (plan.source === "history") fromHistory += 1;
    else fromBank += 1;
  }
  return { fromHistory, fromBank };
}

/**
 * The decisions `autoCategorize` would apply, read-only: a backfill's dry
 * run shows exactly what the real run will write.
 */
export async function planAutoCategories(
  userId: string,
  rows: ReadonlyArray<UncategorisedTransaction>,
  db: AutoDb,
): Promise<PlannedCategory[]> {
  if (rows.length === 0) return [];

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

  // The bank mapping names the shared defaults. A user who customised a
  // default (renamed, moved) has their own copy, which takes its place here.
  const defaults = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
      archivedAt: schema.categories.archivedAt,
    })
    .from(schema.categories)
    .where(isNull(schema.categories.userId));
  const copies = await db
    .select({
      defaultId: schema.categoryOverrides.defaultCategoryId,
      categoryId: schema.categoryOverrides.categoryId,
      archivedAt: schema.categories.archivedAt,
    })
    .from(schema.categoryOverrides)
    .innerJoin(
      schema.categories,
      eq(schema.categories.id, schema.categoryOverrides.categoryId),
    )
    .where(eq(schema.categoryOverrides.userId, userId));
  const copyOf = new Map(copies.map((copy) => [copy.defaultId, copy]));
  /** The category the user has for a default: their live copy, else the live default. */
  const usable = (category: (typeof defaults)[number]): string | null => {
    const copy = copyOf.get(category.id);
    if (copy) return copy.archivedAt === null ? copy.categoryId : null;
    return category.archivedAt === null ? category.id : null;
  };
  const parents = new Map(
    defaults.filter((c) => c.parentId === null).map((c) => [c.name, c]),
  );
  const children = new Map(
    defaults
      .filter((c) => c.parentId !== null)
      .map((c) => [`${c.parentId}|${c.name}`, c]),
  );
  const fromBankCategory = (row: UncategorisedTransaction): string | null => {
    const target = bankCategoryTarget(
      row.plaidCategoryPrimary,
      row.plaidCategoryDetailed,
    );
    if (!target) return null;
    const parent = parents.get(target.parent);
    if (!parent) return null;
    const child = target.child && children.get(`${parent.id}|${target.child}`);
    return (child && usable(child)) || usable(parent);
  };

  return rows.flatMap((row): PlannedCategory[] => {
    const remembered = byMerchant.get(merchantKey(row));
    if (remembered)
      return [
        { transactionId: row.id, categoryId: remembered, source: "history" },
      ];
    const mapped = fromBankCategory(row);
    return mapped
      ? [{ transactionId: row.id, categoryId: mapped, source: "bank" }]
      : [];
  });
}

/** Sync-facing port: categorise what a sync page wrote. */
export type TransactionCategorizer = Readonly<{
  categorize: (
    userId: string,
    rows: ReadonlyArray<UncategorisedTransaction>,
    db: AutoDb,
  ) => Promise<AutoCategorizeResult>;
}>;

export const transactionCategorizer: TransactionCategorizer = {
  categorize: autoCategorize,
};
