import type { AccountRow } from "./accounts.repository.js";

export type AccountAuditSnapshot = Readonly<{
  id: string;
  userId: string;
  plaidItemId: string | null;
  plaidAccountId: string | null;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string;
  mask: string | null;
  currency: string;
  currentBalance: string | null;
  availableBalance: string | null;
  limit: string | null;
  apr: number | null;
  apy: number | null;
  minimumPayment: string | null;
  paymentDueDate: string | null;
  statementBalance: string | null;
  statementDate: string | null;
  originationDate: string | null;
  maturityDate: string | null;
  color: string | null;
  icon: string | null;
  isHidden: boolean;
  excludeFromNetWorth: boolean;
  excludeFromBudgets: boolean;
  excludeFromForecast: boolean;
  defaultMemberId: string | null;
  displayOrder: number;
  isManual: boolean;
  archivedAt: string | null;
  balanceLastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}>;

const cents = (value: bigint | null): string | null =>
  value?.toString() ?? null;
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** Converts every persistence-only bigint/date field before JSONB insertion. */
export function toAccountAuditSnapshot(row: AccountRow): AccountAuditSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    plaidItemId: row.plaidItemId,
    plaidAccountId: row.plaidAccountId,
    name: row.name,
    officialName: row.officialName,
    type: row.type,
    subtype: row.subtype,
    mask: row.mask,
    currency: row.currency,
    currentBalance: cents(row.currentBalance),
    availableBalance: cents(row.availableBalance),
    limit: cents(row.limit),
    apr: row.apr,
    apy: row.apy,
    minimumPayment: cents(row.minimumPayment),
    paymentDueDate: row.paymentDueDate,
    statementBalance: cents(row.statementBalance),
    statementDate: row.statementDate,
    originationDate: row.originationDate,
    maturityDate: row.maturityDate,
    color: row.color,
    icon: row.icon,
    isHidden: row.isHidden,
    excludeFromNetWorth: row.excludeFromNetWorth,
    excludeFromBudgets: row.excludeFromBudgets,
    excludeFromForecast: row.excludeFromForecast,
    defaultMemberId: row.defaultMemberId,
    displayOrder: row.displayOrder,
    isManual: row.isManual,
    archivedAt: iso(row.archivedAt),
    balanceLastRefreshedAt: iso(row.balanceLastRefreshedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  };
}
