import { centsToWire } from "../../shared/money/money.js";
import { toIso } from "../../shared/time/date.js";
import type { AccountWithItem } from "./accounts.repository.js";
import type { AccountSummary } from "./accounts.schemas.js";

export { toAccountAuditSnapshot } from "./accounts-audit.js";

/** Converts an account row and its tenant-scoped Plaid item to wire data. */
export function toAccountSummary(row: AccountWithItem): AccountSummary {
  return {
    id: row.id,
    name: row.nameOverride ?? row.name,
    color: row.color,
    icon: row.icon,
    officialName: row.officialName,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    currency: row.currency,
    currentBalance: centsToWire(row.currentBalance),
    availableBalance: centsToWire(row.availableBalance),
    limit: centsToWire(row.limitOverride ?? row.limit),
    paymentDueDate: row.paymentDueDateOverride ?? row.paymentDueDate,
    institutionName: row.plaidItem?.institutionName ?? null,
    lastSyncAt: toIso(row.balanceLastRefreshedAt),
    isHidden: row.isHidden,
    isManual: row.isManual,
    archivedAt: toIso(row.archivedAt),
    plaidItem: row.plaidItem
      ? {
          id: row.plaidItem.id,
          status: row.plaidItem.status,
          errorCode: row.plaidItem.errorCode,
        }
      : null,
  };
}
