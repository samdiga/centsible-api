import { describe, expect, it } from "vitest";

import {
  CreateRuleBodySchema,
  RulePreviewQuerySchema,
  UpdateRuleBodySchema,
} from "../rules.schemas.js";

const TAG_ID = "66666666-6666-4666-8666-666666666666";

describe("CreateRuleBodySchema", () => {
  it("accepts the three new action fields", () => {
    const result = CreateRuleBodySchema.safeParse({
      matchType: "merchant_contains",
      matchMerchant: "Starbucks",
      actionCategoryId: null,
      actionRename: "Starbucks",
      actionHide: true,
      actionAddTagIds: [TAG_ID],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a rule with every action field null", () => {
    const result = CreateRuleBodySchema.safeParse({
      matchType: "merchant_contains",
      matchMerchant: "Starbucks",
      actionCategoryId: null,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a rule with only actionHide set", () => {
    const result = CreateRuleBodySchema.safeParse({
      matchType: "merchant_contains",
      matchMerchant: "Starbucks",
      actionCategoryId: null,
      actionHide: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("UpdateRuleBodySchema", () => {
  it("accepts match fields and every action, not just the original 3", () => {
    const result = UpdateRuleBodySchema.safeParse({
      matchType: "amount_range",
      matchAmountMin: "500",
      matchAmountMax: "10000",
      actionSetNotes: "large purchase",
      actionMarkReviewed: true,
      actionExcludeFromBudgets: true,
      actionRename: "Big one",
      actionHide: false,
      actionAddTagIds: [TAG_ID],
    });
    expect(result.success).toBe(true);
  });

  it("still accepts a patch that touches only isActive", () => {
    const result = UpdateRuleBodySchema.safeParse({ isActive: false });
    expect(result.success).toBe(true);
  });

  it("rejects an empty patch", () => {
    const result = UpdateRuleBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid tag id", () => {
    const result = UpdateRuleBodySchema.safeParse({
      actionAddTagIds: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });
});

describe("RulePreviewQuerySchema", () => {
  it("accepts an amount-range preview query", () => {
    const result = RulePreviewQuerySchema.safeParse({
      matchType: "amount_range",
      matchAmountMin: "500",
      matchAmountMax: "10000",
    });
    expect(result.success).toBe(true);
  });

  it("still accepts a merchant-only preview query", () => {
    const result = RulePreviewQuerySchema.safeParse({
      matchType: "merchant_contains",
      matchMerchant: "Starbucks",
    });
    expect(result.success).toBe(true);
  });
});
