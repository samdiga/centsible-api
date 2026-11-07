import { and, sql, type SQL } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";

/**
 * A transaction's counted category lines (T-186): the one definition every
 * per-category total uses, so a split counts each line under its own
 * category and nothing counts twice.
 *
 * - Unsplit: one line, the transaction's own category and amount.
 * - Split: its lines from transaction_category_splits.
 * - Split out of balance (the bank changed the amount and the lines no longer
 *   add up): one line, the transaction's stored category_id (the largest
 *   line's) and its full amount, until the user saves new lines.
 *
 * Exposed as columns `category_id` and `amount_cents` of the alias
 * `spend_line`. The SQL refers to the outer `transactions` table, so the
 * caller's query must select from `transactions` unaliased. Transaction-level
 * conditions (status, exclude_from_budgets, account filters) stay on
 * `transactions` and drop every line of a transaction at once.
 */
function spendLinesSelect(): SQL {
  const t = schema.transactions;
  const s = schema.transactionCategorySplits;
  return sql`(
    SELECT ${s.categoryId} AS category_id, ${s.amount} AS amount_cents
      FROM ${s}
     WHERE ${s.transactionId} = ${t.id} AND NOT ${t.splitOutOfBalance}
    UNION ALL
    SELECT ${t.categoryId} AS category_id, ${t.amount} AS amount_cents
     WHERE ${t.splitOutOfBalance}
        OR NOT EXISTS (
          SELECT 1 FROM ${s} AS split_check
           WHERE split_check.transaction_id = ${t.id}
        )
  ) AS spend_line`;
}

/** For `.crossJoinLateral(...)`: one row per counted line of each transaction. */
export function spendLinesJoin(): SQL {
  return spendLinesSelect();
}

/** The current line's category (`null`: uncategorised). */
export function spendLineCategoryId(): SQL<string | null> {
  return sql<string | null>`spend_line.category_id`;
}

/** The current line's amount in cents (Plaid sign). */
export function spendLineAmount(): SQL<bigint> {
  return sql<bigint>`spend_line.amount_cents`;
}

/**
 * For list filters: whether any counted line of the outer transaction meets
 * `conditions`, and those lines' summed amount. Inside `conditions`,
 * `schema.categories` is the line's category (LEFT JOINed), and
 * spendLineCategoryId()/spendLineAmount() are the line, so one line must meet
 * every condition: a Restaurants budget drill-in counts only the Restaurants
 * line, and only if that line is budget spend.
 */
export function spendLinesMatching(conditions: readonly SQL[]): {
  exists: SQL;
  amount: SQL<string | null>;
} {
  const from = sql`FROM ${spendLinesSelect()}
    LEFT JOIN ${schema.categories}
      ON ${schema.categories.id} = spend_line.category_id
    WHERE ${and(...conditions) ?? sql`true`}`;
  return {
    exists: sql`EXISTS (SELECT 1 ${from})`,
    amount: sql<string | null>`(SELECT sum(spend_line.amount_cents) ${from})`,
  };
}
