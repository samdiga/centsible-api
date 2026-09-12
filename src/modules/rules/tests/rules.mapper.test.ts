import { describe, expect, it } from "vitest";

import { toRuleDto } from "../rules.mapper.js";
import type { RuleRow } from "../rules.repository.js";

const row: RuleRow = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  name: "Starbucks",
  priority: 10,
  matchType: "merchant_contains",
  matchMerchant: "Starbucks",
  matchNameContains: null,
  matchAmountMin: null,
  matchAmountMax: null,
  matchAccountId: null,
  actionCategoryId: "33333333-3333-4333-8333-333333333333",
  actionMemberId: null,
  actionSetNotes: null,
  actionAddTags: ["44444444-4444-4444-8444-444444444444"],
  actionRename: "Starbucks",
  actionHide: true,
  actionMarkReviewed: null,
  actionExcludeFromBudgets: null,
  isActive: true,
  applyToExisting: false,
  lastAppliedAt: null,
  timesApplied: 0,
  createdAt: new Date("2026-09-12T00:00:00.000Z"),
  updatedAt: new Date("2026-09-12T00:00:00.000Z"),
};

describe("toRuleDto", () => {
  it("includes the three new action fields", () => {
    const dto = toRuleDto(row);
    expect(dto.actionRename).toBe("Starbucks");
    expect(dto.actionHide).toBe(true);
    expect(dto.actionAddTagIds).toEqual(["44444444-4444-4444-8444-444444444444"]);
  });
});
