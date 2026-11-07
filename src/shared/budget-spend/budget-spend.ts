import { inArray, sql, type SQL } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import { spendLineCategoryId } from "../spend-lines/spend-lines.js";

/**
 * Which transactions count as budget spend: the one definition behind
 * GET /budgets/active/usage and GET /transactions?budget=true, so a Budget
 * row and its drill-in always add up to the same amount.
 *
 * Pending and posted, refunds included (negative amounts). Out: transactions
 * excluded from budgets, card payments, and anything in a category that is
 * left out of budgets (itself or its group, see categoryLeftOutOfBudgets), a transfer or income; an uncategorised paycheck or
 * transfer (by Plaid's category) is not a refund either.
 *
 * Conditions apply per counted line of a transaction (T-186 splits; see
 * spend-lines.ts): callers read from `transactions` with its `spend_line`
 * (spendLinesJoin, or inside spendLinesMatching) and LEFT JOIN `categories`
 * on `spend_line.category_id`. Callers add the user, date range and
 * deleted/live-account filters.
 */
/**
 * True when a category is left out of budgets: by its own switch, or because
 * its group is (T-188). A group that's off covers every subcategory, including
 * ones added later, and none can be switched back on; the subcategories' own
 * flags are left as they were, so turning the group back on restores them.
 * `category` is the categories table or an alias of it.
 */
export function categoryLeftOutOfBudgets(
  category: typeof schema.categories = schema.categories,
): SQL {
  return sql`(COALESCE(${category.excludeFromBudgets}, false) OR EXISTS (
    SELECT 1 FROM ${schema.categories} AS budget_parent
    WHERE budget_parent.id = ${category.parentId}
      AND budget_parent.exclude_from_budgets
  ))`;
}

export function budgetSpendConditions(): SQL[] {
  const t = schema.transactions;
  const c = schema.categories;
  return [
    inArray(t.status, ["pending", "posted"]),
    sql`${t.excludeFromBudgets} = false`,
    sql`${t.plaidCategoryDetailed} IS DISTINCT FROM 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'`,
    sql`NOT ${categoryLeftOutOfBudgets(c)}`,
    sql`COALESCE(${c.isTransfer}, false) = false`,
    sql`COALESCE(${c.isIncome}, false) = false`,
    // Without a category there are no flags to read, so Plaid's says what
    // it is: an uncategorised paycheck or transfer is not a refund.
    sql`NOT (${spendLineCategoryId()} IS NULL AND COALESCE(${t.plaidCategoryPrimary}, '') IN ('INCOME', 'TRANSFER_IN', 'TRANSFER_OUT'))`,
  ];
}
