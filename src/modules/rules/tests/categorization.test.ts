import { describe, expect, it } from "vitest";

import {
  matchRules,
  type RuleForMatching,
  type TransactionForMatching,
} from "../categorization.js";

const transaction: TransactionForMatching = {
  merchantName: "Whole Foods Market",
  name: "WHOLEFDS MKTPLACE #123",
  amount: 8423n,
  accountId: "acct-001",
};

const baseRule: RuleForMatching = {
  id: "r1",
  priority: 100,
  matchType: "merchant_exact",
  matchMerchant: "Whole Foods Market",
  matchNameContains: null,
  matchAmountMin: null,
  matchAmountMax: null,
  matchAccountId: null,
  actionCategoryId: "cat-groceries",
  actionMemberId: null,
  actionSetNotes: null,
  actionMarkReviewed: null,
  actionExcludeFromBudgets: null,
  actionRename: null,
  actionHide: null,
  actionAddTagIds: null,
};

describe("matchRules", () => {
  it("returns the exact rule for a case-insensitive merchant match", () => {
    const rule = { ...baseRule, matchMerchant: "whole foods market" };
    expect(matchRules(transaction, [rule])).toBe(rule);
  });

  it("returns null for a different merchant or missing merchant", () => {
    expect(
      matchRules(transaction, [{ ...baseRule, matchMerchant: "Amazon" }]),
    ).toBeNull();
    expect(
      matchRules({ ...transaction, merchantName: null }, [baseRule]),
    ).toBeNull();
  });

  it("matches exact and contains text case-insensitively", () => {
    expect(
      matchRules(transaction, [
        { ...baseRule, matchMerchant: "whole foods market" },
      ]),
    ).not.toBeNull();
    expect(
      matchRules(transaction, [
        {
          ...baseRule,
          matchType: "merchant_contains",
          matchMerchant: "WHOLE FOODS",
        },
      ]),
    ).not.toBeNull();
    expect(
      matchRules(transaction, [
        {
          ...baseRule,
          matchType: "name_contains",
          matchMerchant: null,
          matchNameContains: "wholefds",
        },
      ]),
    ).not.toBeNull();
  });

  it("uses inclusive amount boundaries and preserves signed amounts", () => {
    expect(
      matchRules({ ...transaction, amount: -500n }, [
        {
          ...baseRule,
          matchType: "amount_range",
          matchMerchant: null,
          matchAmountMin: -500n,
          matchAmountMax: -500n,
        },
      ]),
    ).not.toBeNull();
    expect(
      matchRules(transaction, [
        {
          ...baseRule,
          matchType: "amount_range",
          matchMerchant: null,
          matchAmountMin: 8424n,
          matchAmountMax: null,
        },
      ]),
    ).toBeNull();
    expect(
      matchRules(transaction, [
        {
          ...baseRule,
          matchType: "amount_exact",
          matchMerchant: null,
          matchAmountMin: 8423n,
        },
      ]),
    ).not.toBeNull();
  });

  it("treats omitted range boundaries as unbounded", () => {
    expect(
      matchRules(transaction, [
        {
          ...baseRule,
          matchType: "amount_range",
          matchMerchant: null,
          matchAmountMin: null,
          matchAmountMax: null,
        },
      ]),
    ).not.toBeNull();
  });

  it("requires both merchant and amount for combo rules", () => {
    const rule = {
      ...baseRule,
      matchType: "combo" as const,
      matchAmountMin: 8423n,
      matchAmountMax: 8423n,
    };
    expect(matchRules(transaction, [rule])).toBe(rule);
    expect(
      matchRules(transaction, [{ ...rule, matchMerchant: "Amazon" }]),
    ).toBeNull();
    expect(
      matchRules(transaction, [
        { ...rule, matchAmountMin: null, matchAmountMax: null },
      ]),
    ).toBeNull();
  });

  it("selects the lowest priority and keeps input order for equal priorities", () => {
    const first = { ...baseRule, id: "first", priority: 50 };
    const tied = { ...baseRule, id: "tied", priority: 50 };
    const lower = { ...baseRule, id: "lower", priority: 100 };
    expect(matchRules(transaction, [lower, tied, first])?.id).toBe("tied");
  });

  it("filters by account and returns null when no rules match", () => {
    expect(
      matchRules(transaction, [{ ...baseRule, matchAccountId: "acct-other" }]),
    ).toBeNull();
    expect(
      matchRules({ ...transaction, merchantName: null }, [baseRule]),
    ).toBeNull();
    expect(matchRules(transaction, [])).toBeNull();
  });
});
