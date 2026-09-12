import { centsToWire } from "../../shared/money/money.js";
import type { RuleDto } from "./rules.schemas.js";
import type { RuleRow } from "./rules.repository.js";

export function toRuleDto(row: RuleRow): RuleDto {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    matchType: row.matchType,
    matchMerchant: row.matchMerchant,
    matchNameContains: row.matchNameContains,
    matchAmountMin: centsToWire(row.matchAmountMin),
    matchAmountMax: centsToWire(row.matchAmountMax),
    matchAccountId: row.matchAccountId,
    actionCategoryId: row.actionCategoryId,
    actionMemberId: row.actionMemberId,
    actionSetNotes: row.actionSetNotes,
    actionMarkReviewed: row.actionMarkReviewed,
    actionExcludeFromBudgets: row.actionExcludeFromBudgets,
    actionRename: row.actionRename,
    actionHide: row.actionHide,
    actionAddTagIds: row.actionAddTags,
    isActive: row.isActive,
    applyToExisting: row.applyToExisting,
    timesApplied: row.timesApplied,
    lastAppliedAt: row.lastAppliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
