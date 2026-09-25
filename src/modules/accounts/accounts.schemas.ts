import { z } from "zod";

export const AccountIdSchema = z.string().uuid();

export interface PlaidAccountData {
  account_id: string;
  name: string;
  official_name?: string | null;
  type: string;
  subtype?: string | null;
  mask?: string | null;
  balances: {
    current?: number | null;
    available?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
  };
}
export const AccountTypeSchema = z.enum([
  "depository",
  "credit",
  "loan",
  "investment",
  "other",
]);
export const AccountSubtypeSchema = z.enum([
  "checking",
  "savings",
  "money_market",
  "cd",
  "hsa",
  "credit_card",
  "line_of_credit",
  "paypal",
  "mortgage",
  "auto",
  "student",
  "personal_loan",
  "brokerage",
  "ira",
  "401k",
  "403b",
  "529",
  "roth",
  "roth_401k",
  "manual_home",
  "manual_vehicle",
  "crypto",
  "cash",
  "other",
]);
export const PlaidItemStatusSchema = z.enum([
  "active",
  "login_required",
  "pending_expiration",
  "error",
  "disconnected",
]);

export const AccountSummarySchema = z.object({
  id: AccountIdSchema,
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  officialName: z.string().nullable(),
  mask: z.string().nullable(),
  type: AccountTypeSchema,
  subtype: AccountSubtypeSchema,
  currency: z.string(),
  currentBalance: z.string().nullable(),
  availableBalance: z.string().nullable(),
  limit: z.string().nullable(),
  paymentDueDate: z.iso.date().nullable(),
  institutionName: z.string().nullable(),
  lastSyncAt: z.string().datetime({ offset: true }).nullable(),
  isHidden: z.boolean(),
  isManual: z.boolean(),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  plaidItem: z
    .object({
      id: AccountIdSchema,
      status: PlaidItemStatusSchema,
      errorCode: z.string().nullable(),
    })
    .nullable(),
  /**
   * What the bank reports, underneath any override — so an editor can show
   * "bank's value vs yours". Null for manual accounts, which have no bank.
   */
  bank: z
    .object({
      name: z.string(),
      limit: z.string().nullable(),
      paymentDueDate: z.iso.date().nullable(),
    })
    .nullable(),
  /** Which of name / limit / paymentDueDate currently use the user's value. */
  overridden: z.object({
    name: z.boolean(),
    limit: z.boolean(),
    paymentDueDate: z.boolean(),
  }),
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

export const AccountListResponseSchema = z.object({
  accounts: z.array(AccountSummarySchema),
});
export const AccountSummaryWireSchema = AccountSummarySchema;
export const AccountSummaryListResponseSchema = AccountListResponseSchema;

export const AccountBalanceSchema = z.object({
  accountId: AccountIdSchema,
  plaidAccountId: z.string(),
  current: z.number().nullable(),
  available: z.number().nullable(),
  limit: z.number().nullable(),
  currency: z.string().nullable(),
});
export type AccountBalance = z.infer<typeof AccountBalanceSchema>;
export const RefreshAccountResponseSchema = z.object({
  account: AccountBalanceSchema,
});
export const RefreshAccountBalanceOutput = RefreshAccountResponseSchema;
export const DeleteAccountResponseSchema = z.object({
  ok: z.literal(true),
  unlinkedItem: z.boolean(),
});

export const ManualAccountSubtypeSchema = z.enum([
  "cash",
  "checking",
  "savings",
  "credit_card",
]);

const MoneyCentsInputSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform((value) => BigInt(value));

export const CreateManualAccountBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    subtype: ManualAccountSubtypeSchema,
    openingBalanceCents: MoneyCentsInputSchema,
    limitCents: MoneyCentsInputSchema.refine((value) => value >= 0n, {
      message: "Limit must be zero or positive",
    }).optional(),
  })
  .refine(
    (value) =>
      value.subtype === "credit_card" || value.limitCents === undefined,
    {
      message: "limitCents is only valid for credit_card accounts",
      path: ["limitCents"],
    },
  );
export type CreateManualAccountInput = z.infer<
  typeof CreateManualAccountBodySchema
>;

export const CreateAccountResponseSchema = z.object({
  account: AccountSummarySchema,
});

export const AccountListQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export const UpdateAccountBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    limitCents: MoneyCentsInputSchema.refine((value) => value >= 0n, {
      message: "Limit must be zero or positive",
    })
      .nullable()
      .optional(),
    color: z.string().trim().min(1).max(32).nullable().optional(),
    icon: z.string().trim().min(1).max(64).nullable().optional(),
    paymentDueDate: z.iso.date().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.limitCents !== undefined ||
      value.color !== undefined ||
      value.icon !== undefined ||
      value.paymentDueDate !== undefined ||
      value.archived !== undefined,
    {
      message:
        "Provide at least one of name, limitCents, color, icon, paymentDueDate, archived",
    },
  );
export type UpdateAccountInput = z.infer<typeof UpdateAccountBodySchema>;
export const UpdateAccountResponseSchema = CreateAccountResponseSchema;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
