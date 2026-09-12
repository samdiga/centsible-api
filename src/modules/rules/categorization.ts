import type { RuleMatchType } from "./rules.schemas.js";

export interface TransactionForMatching {
  merchantName: string | null;
  name: string;
  amount: bigint;
  accountId: string;
}

export interface RuleForMatching {
  id: string;
  priority: number;
  matchType: RuleMatchType;
  matchMerchant: string | null;
  matchNameContains: string | null;
  matchAmountMin: bigint | null;
  matchAmountMax: bigint | null;
  matchAccountId: string | null;
  actionCategoryId: string | null;
  actionMemberId: string | null;
  actionSetNotes: string | null;
  actionMarkReviewed: boolean | null;
  actionExcludeFromBudgets: boolean | null;
  actionRename: string | null;
  actionHide: boolean | null;
  actionAddTagIds: string[] | null;
}

function inAmountRange(
  transaction: TransactionForMatching,
  rule: RuleForMatching,
): boolean {
  if (
    rule.matchAmountMin !== null &&
    transaction.amount < rule.matchAmountMin
  ) {
    return false;
  }
  if (
    rule.matchAmountMax !== null &&
    transaction.amount > rule.matchAmountMax
  ) {
    return false;
  }
  return true;
}

function matchesCore(
  transaction: TransactionForMatching,
  rule: RuleForMatching,
): boolean {
  switch (rule.matchType) {
    case "merchant_exact":
      return (
        transaction.merchantName !== null &&
        rule.matchMerchant !== null &&
        transaction.merchantName.toLowerCase() ===
          rule.matchMerchant.toLowerCase()
      );
    case "merchant_contains":
      return (
        transaction.merchantName !== null &&
        rule.matchMerchant !== null &&
        transaction.merchantName
          .toLowerCase()
          .includes(rule.matchMerchant.toLowerCase())
      );
    case "name_contains":
      return (
        rule.matchNameContains !== null &&
        transaction.name
          .toLowerCase()
          .includes(rule.matchNameContains.toLowerCase())
      );
    case "amount_exact":
      return (
        rule.matchAmountMin !== null &&
        transaction.amount === rule.matchAmountMin
      );
    case "amount_range":
      return inAmountRange(transaction, rule);
    case "combo":
      return (
        transaction.merchantName !== null &&
        rule.matchMerchant !== null &&
        transaction.merchantName.toLowerCase() ===
          rule.matchMerchant.toLowerCase() &&
        (rule.matchAmountMin !== null || rule.matchAmountMax !== null) &&
        inAmountRange(transaction, rule)
      );
  }
}

export function matchRules(
  transaction: TransactionForMatching,
  rules: RuleForMatching[],
): RuleForMatching | null {
  const sorted = rules
    .map((rule, index) => ({ rule, index }))
    .sort(
      (left, right) =>
        left.rule.priority - right.rule.priority || left.index - right.index,
    )
    .map(({ rule }) => rule);
  for (const rule of sorted) {
    if (
      rule.matchAccountId !== null &&
      transaction.accountId !== rule.matchAccountId
    ) {
      continue;
    }
    if (matchesCore(transaction, rule)) return rule;
  }
  return null;
}
