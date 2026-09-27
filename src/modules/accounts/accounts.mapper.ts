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
    subtype: row.subtypeOverride ?? row.subtype,
    currency: row.currency,
    currentBalance: centsToWire(row.currentBalance),
    availableBalance: centsToWire(row.availableBalance),
    limit: centsToWire(row.limitOverride ?? row.limit),
    paymentDueDate: row.paymentDueDateOverride ?? row.paymentDueDate,
    statementBalance: centsToWire(row.statementBalance),
    statementDate: row.statementDate,
    lastPaymentCents: centsToWire(row.lastPaymentCents),
    lastPaymentDate: row.lastPaymentDate ?? null,
    cardPaymentRule: row.cardPaymentRule ?? "full",
    cardPlannedPaymentCents: centsToWire(row.cardPlannedPaymentCents),
    minimumPayment: centsToWire(row.minimumPayment),
    apr: row.apr,
    apy: row.apyOverride ?? row.apy,
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
    bank: row.isManual
      ? null
      : {
          name: row.name,
          limit: centsToWire(row.limit),
          paymentDueDate: row.paymentDueDate,
          subtype: row.subtype,
          apy: row.apy,
        },
    overridden: {
      name: row.nameOverride !== null,
      limit: row.limitOverride !== null,
      paymentDueDate: row.paymentDueDateOverride !== null,
      subtype: row.subtypeOverride != null,
      apy: row.apyOverride != null,
    },
  };
}
