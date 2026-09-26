import type { RuleForMatching } from "../rules/index.js";
import type {
  TransactionPatchFields,
  TransactionRow,
} from "./transactions.repository.js";

/**
 * The fields a matched rule changes on a newly written transaction. Only
 * fills what is still empty or at its default, so it never overwrites a
 * value the user already set. Shared by Plaid sync and manual entry.
 */
export function rulePatch(
  row: TransactionRow,
  rule?: RuleForMatching,
): TransactionPatchFields {
  if (!rule) return {};
  return {
    ...(rule.actionCategoryId ? { categoryId: rule.actionCategoryId } : {}),
    ...(rule.actionMemberId && !row.householdMemberId
      ? { householdMemberId: rule.actionMemberId }
      : {}),
    ...(rule.actionSetNotes && !row.notes
      ? { notes: rule.actionSetNotes }
      : {}),
    ...(rule.actionMarkReviewed && row.reviewStatus === "needs_review"
      ? { reviewStatus: "reviewed" as const }
      : {}),
    ...(rule.actionExcludeFromBudgets && !row.excludeFromBudgets
      ? { excludeFromBudgets: true }
      : {}),
    ...(rule.actionRename && !row.userName
      ? { userName: rule.actionRename }
      : {}),
    ...(rule.actionHide && row.reviewStatus === "needs_review"
      ? { reviewStatus: "hidden" as const }
      : {}),
  };
}
