import { inArray, sql, type SQL } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";

/**
 * Which transactions count as budget spend: the one definition behind
 * GET /budgets/active/usage and GET /transactions?budget=true, so a Budget
 * row and its drill-in always add up to the same amount.
 *
 * Pending and posted, refunds included (negative amounts). Out: transactions
 * excluded from budgets, card payments, and anything in a category that is
 * excluded from budgets, a transfer or income; an uncategorised paycheck or
 * transfer (by Plaid's category) is not a refund either.
 *
 * Callers add the user, date range and deleted/live-account filters, and must
 * LEFT JOIN `categories` on `transactions.category_id`.
 */
export function budgetSpendConditions(): SQL[] {
  const t = schema.transactions;
  const c = schema.categories;
  return [
    inArray(t.status, ["pending", "posted"]),
    sql`${t.excludeFromBudgets} = false`,
    sql`${t.plaidCategoryDetailed} IS DISTINCT FROM 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'`,
    sql`COALESCE(${c.excludeFromBudgets}, false) = false`,
    sql`COALESCE(${c.isTransfer}, false) = false`,
    sql`COALESCE(${c.isIncome}, false) = false`,
    // Without a category there are no flags to read, so Plaid's says what
    // it is: an uncategorised paycheck or transfer is not a refund.
    sql`NOT (${t.categoryId} IS NULL AND COALESCE(${t.plaidCategoryPrimary}, '') IN ('INCOME', 'TRANSFER_IN', 'TRANSFER_OUT'))`,
  ];
}
