import { centsToWire } from "../../shared/money/money.js";
import { toIso } from "../../shared/time/date.js";
import type { AccountWithItem } from "./accounts.repository.js";
import type { AccountSummary } from "./accounts.schemas.js";

export { toAccountAuditSnapshot } from "./accounts-audit.js";

/** Converts an account row and its tenant-scoped Plaid item to wire data. */
export function toAccountSummary(row: AccountWithItem): AccountSummary {
  return {
    id: row.id,
    name: row.name,
    officialName: row.officialName,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    currency: row.currency,
    currentBalance: centsToWire(row.currentBalance),
    availableBalance: centsToWire(row.availableBalance),
    institutionName: row.plaidItem.institutionName,
    lastSyncAt: toIso(row.balanceLastRefreshedAt),
    isHidden: row.isHidden,
    plaidItem: {
      id: row.plaidItem.id,
      status: row.plaidItem.status,
      errorCode: row.plaidItem.errorCode,
    },
  };
}
