import { z } from "zod";

export const BACKUP_VERSION = 2 as const;
const UuidSchema = z.string().uuid();
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const MoneySchema = z.string().regex(/^-?\d+$/);

export const BackupAccountSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  officialName: z.string().nullable(),
  mask: z.string().nullable(),
  type: z.string(),
  subtype: z.string().nullable(),
  currency: z.string().nullable(),
  currentBalance: MoneySchema.nullable(),
  availableBalance: MoneySchema.nullable(),
  isHidden: z.boolean(),
});

export const BackupTransactionSchema = z.object({
  id: UuidSchema,
  accountId: UuidSchema,
  plaidTransactionId: z.string().nullable(),
  amount: MoneySchema,
  currency: z.string().nullable(),
  date: IsoDateSchema,
  name: z.string(),
  merchantName: z.string().nullable(),
  userName: z.string().nullable(),
  categoryId: UuidSchema.nullable(),
  notes: z.string().nullable(),
  status: z.enum(["posted", "pending", "removed"]),
  reviewStatus: z.enum(["needs_review", "reviewed", "hidden"]),
  excludeFromBudgets: z.boolean(),
  excludeFromReports: z.boolean(),
  userCategoryOverride: z.boolean(),
  tagIds: z.array(UuidSchema),
});

export const BackupTagSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  color: z.string().nullable(),
});

export const BackupCategorySchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  isIncome: z.boolean(),
  isTransfer: z.boolean(),
  excludeFromBudgets: z.boolean(),
  displayOrder: z.number().int(),
});

export const BackupRuleSchema = z.object({
  id: UuidSchema,
  name: z.string().nullable(),
  priority: z.number().int(),
  matchType: z.enum([
    "merchant_exact",
    "merchant_contains",
    "name_contains",
    "amount_exact",
    "amount_range",
    "combo",
  ]),
  matchMerchant: z.string().nullable(),
  matchNameContains: z.string().nullable(),
  matchAmountMin: MoneySchema.nullable(),
  matchAmountMax: MoneySchema.nullable(),
  matchAccountId: UuidSchema.nullable(),
  actionCategoryId: UuidSchema.nullable(),
  actionMemberId: UuidSchema.nullable(),
  actionSetNotes: z.string().nullable(),
  actionAddTags: z.array(z.string()).nullable(),
  actionMarkReviewed: z.boolean().nullable(),
  actionExcludeFromBudgets: z.boolean().nullable(),
  isActive: z.boolean(),
});

export const BackupBudgetItemSchema = z.object({
  categoryId: UuidSchema,
  amountCents: MoneySchema,
  rolloverBehavior: z.enum(["none", "roll_positive", "roll_all"]),
});

export const BackupBudgetSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  style: z.enum(["flex", "category_zero_based"]),
  period: z.enum(["monthly", "biweekly", "weekly"]),
  startDate: IsoDateSchema,
  isActive: z.boolean(),
  budgetItems: z.array(BackupBudgetItemSchema),
});

export const BackupRecurringSchema = z.object({
  id: UuidSchema,
  accountId: UuidSchema.nullable(),
  toAccountId: UuidSchema.nullable(),
  categoryId: UuidSchema.nullable(),
  canonicalName: z.string(),
  billType: z.enum(["payable", "transfer"]),
  isIncome: z.boolean(),
  cadence: z.enum([
    "daily",
    "weekly",
    "biweekly",
    "semimonthly",
    "monthly",
    "quarterly",
    "annual",
    "irregular",
  ]),
  dayOfMonth: z.number().int().nullable(),
  dayOfWeek: z.number().int().nullable(),
  avgAmount: MoneySchema,
  nextExpectedDate: IsoDateSchema.nullable(),
  status: z.enum(["active", "paused", "ended", "pending_confirmation"]),
  userConfirmed: z.boolean(),
  notes: z.string().nullable(),
});

export const BackupNetWorthSnapshotSchema = z.object({
  date: IsoDateSchema,
  netWorthCents: MoneySchema,
  assetsCents: MoneySchema,
  liabilitiesCents: MoneySchema,
  liquidAssetsCents: MoneySchema,
  breakdown: z.record(z.string(), z.number()),
});

export const BackupPayloadSchema = z.object({
  version: z.number().int(),
  exportedAt: IsoDateTimeSchema,
  accounts: z.array(BackupAccountSchema),
  transactions: z.array(BackupTransactionSchema),
  categories: z.array(BackupCategorySchema),
  tags: z.array(BackupTagSchema),
  rules: z.array(BackupRuleSchema),
  budgets: z.array(BackupBudgetSchema),
  recurring: z.array(BackupRecurringSchema),
  netWorthSnapshots: z.array(BackupNetWorthSnapshotSchema),
});
export type BackupPayload = z.infer<typeof BackupPayloadSchema>;
export type BackupTransaction = z.infer<typeof BackupTransactionSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
export const UserDataActionResponseSchema = z.object({ ok: z.literal(true) });
