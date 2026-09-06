import { describe, expect, it, vi } from "vitest";

import type { RuleForMatching } from "../categorization.js";
import {
  applyRuleRetroactively,
  desiredActionPatch,
  transactionNeedsActionUpdate,
} from "../retroactive.js";

const rule: RuleForMatching = {
  id: "11111111-1111-4111-8111-111111111111",
  priority: 1,
  matchType: "merchant_exact",
  matchMerchant: "Netflix",
  matchNameContains: null,
  matchAmountMin: null,
  matchAmountMax: null,
  matchAccountId: null,
  actionCategoryId: "22222222-2222-4222-8222-222222222222",
  actionMemberId: "33333333-3333-4333-8333-333333333333",
  actionSetNotes: "streaming",
  actionMarkReviewed: true,
  actionExcludeFromBudgets: true,
};

describe("applyRuleRetroactively", () => {
  it("builds only actionable fields and recognizes an already-applied transaction", () => {
    const patch = desiredActionPatch(rule);
    expect(patch).toEqual({
      categoryId: rule.actionCategoryId,
      userCategoryOverride: true,
      householdMemberId: rule.actionMemberId,
      notes: "streaming",
      reviewStatus: "reviewed",
      excludeFromBudgets: true,
    });
    expect(
      transactionNeedsActionUpdate(
        {
          categoryId: rule.actionCategoryId,
          userCategoryOverride: true,
          householdMemberId: rule.actionMemberId,
          notes: "streaming",
          reviewStatus: "reviewed",
          excludeFromBudgets: true,
        },
        patch,
      ),
    ).toBe(false);
    expect(
      transactionNeedsActionUpdate(
        { categoryId: null, userCategoryOverride: false },
        patch,
      ),
    ).toBe(true);
  });

  it("treats a rule with no actions as a zero-change application", () => {
    expect(
      desiredActionPatch({
        ...rule,
        actionCategoryId: null,
        actionMemberId: null,
        actionSetNotes: null,
        actionMarkReviewed: null,
        actionExcludeFromBudgets: null,
      }),
    ).toEqual({});
  });

  it("does not enter a mutation for a missing rule", async () => {
    const withUserMutation = vi.fn(async (_userId, callback) => callback({}));
    const repository = {
      findRuleByIdForUpdate: vi.fn(async () => null),
    } as never;
    await applyRuleRetroactively(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      { repository, withUserMutation },
    );
    expect(withUserMutation).toHaveBeenCalledTimes(1);
  });
});
