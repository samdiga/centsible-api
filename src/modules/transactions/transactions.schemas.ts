import { z } from "zod";

export const TransactionIdSchema = z.string().uuid();
export const TransactionStatusSchema = z.enum(["posted", "pending", "removed"]);
export const ReviewStatusSchema = z.enum([
  "needs_review",
  "reviewed",
  "hidden",
]);

export const TransactionSplitLineDtoSchema = z.object({
  categoryId: z.string().uuid().nullable(),
  amount: z.string().regex(/^-?\d+$/),
  position: z.number().int().nonnegative(),
  isRemainder: z.boolean(),
});

export const TransactionDtoSchema = z.object({
  id: TransactionIdSchema,
  accountId: z.string().uuid(),
  amount: z.string().regex(/^-?\d+$/),
  currency: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: TransactionStatusSchema,
  name: z.string(),
  merchantName: z.string().nullable(),
  paymentChannel: z.string().nullable(),
  plaidCategoryPrimary: z.string().nullable(),
  plaidCategoryDetailed: z.string().nullable(),
  categoryId: z.string().uuid().nullable(),
  userCategoryOverride: z.boolean(),
  isRecurring: z.boolean(),
  reviewStatus: ReviewStatusSchema,
  userName: z.string().nullable(),
  notes: z.string().nullable(),
  tagIds: z.array(z.string().uuid()),
  /** True for a transaction the user entered on a manual account (no Plaid id). */
  isManual: z.boolean(),
  /**
   * Split transactions (T-186), all additive. `categoryId` above is the
   * split's largest line's category. `splits` is on single-transaction
   * responses only (empty when unsplit); lists carry `splitCategoryIds`
   * instead, in line order. `splitOutOfBalance`: the bank changed the amount
   * and the lines no longer add up; the whole charge counts under categoryId
   * until the user saves new lines.
   */
  splits: z.array(TransactionSplitLineDtoSchema).optional(),
  splitCategoryIds: z.array(z.string().uuid().nullable()).optional(),
  splitOutOfBalance: z.boolean().optional(),
  /**
   * Only on lists filtered by category, uncategorised or budget: the part of
   * the amount in the filter (a split's matching lines; otherwise `amount`).
   */
  filteredAmount: z
    .string()
    .regex(/^-?\d+$/)
    .optional(),
});
export type TransactionDto = z.infer<typeof TransactionDtoSchema>;

/** `true` or `false` in a query string; absent is undefined. */
const booleanQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

export const TransactionListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  accountId: z.string().uuid().optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  q: z.string().min(1).max(200).optional(),
  /** Comma-separated category ids. */
  categoryIds: z
    .string()
    .transform((value) => value.split(",").filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(50))
    .optional(),
  /** With categoryIds: a group also matches its subcategories. */
  includeChildren: booleanQuery,
  /** Only transactions without a category. */
  uncategorized: booleanQuery,
  /**
   * Only what Budget usage counts as spend (the same rules), hidden
   * transactions included, so a drill-in adds up to its Budget row.
   */
  budget: booleanQuery,
});
export type TransactionListQuery = z.infer<typeof TransactionListQuerySchema>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    { message: "Must be a real calendar date" },
  );

export const TransactionPatchSchema = z
  .object({
    amount: z
      .string()
      .regex(/^-?\d{1,12}$/, "Integer cents as a string, up to 12 digits")
      .transform((value) => BigInt(value)),
    date: isoDate,
    name: z.string().trim().min(1).max(200),
    merchantName: z.string().trim().min(1).max(200).nullable(),
    accountId: z.string().uuid(),
    userName: z.string().nullable(),
    notes: z.string().nullable(),
    categoryId: z.string().uuid().nullable(),
    householdMemberId: z.string().uuid().nullable(),
    reviewStatus: ReviewStatusSchema,
    excludeFromBudgets: z.boolean(),
    excludeFromReports: z.boolean(),
    tagIds: z.array(z.string().uuid()).max(50),
  })
  .partial();
export type TransactionPatch = z.infer<typeof TransactionPatchSchema>;

const centsString = z
  .string()
  .regex(/^-?\d{1,12}$/, "Integer cents as a string, up to 12 digits")
  .transform((value) => BigInt(value));

/**
 * PUT /transactions/{id}/splits: the full set of lines (T-186). Two or more
 * lines split the transaction; one line gives it that line's category; none
 * unsplits it, keeping its current category. `expectedAmount` is the amount
 * the user split, so a bank change in the meantime is a 409, not a guess.
 */
export const TransactionSplitsPutSchema = z
  .object({
    expectedAmount: centsString,
    lines: z
      .array(
        z
          .object({
            categoryId: z.string().uuid().nullable(),
            amount: centsString,
            isRemainder: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type TransactionSplitsPut = z.infer<typeof TransactionSplitsPutSchema>;

export const TransactionBulkPatchSchema = z.object({
  ids: z.array(TransactionIdSchema).min(1).max(500),
  patch: z
    .object({
      categoryId: z.string().uuid().nullable(),
      reviewStatus: ReviewStatusSchema,
      excludeFromBudgets: z.boolean(),
      householdMemberId: z.string().uuid().nullable(),
      tagIds: z.array(z.string().uuid()).max(50),
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: "At least one patch field required",
    }),
});
export type TransactionBulkPatch = z.infer<typeof TransactionBulkPatchSchema>;

/** POST /transactions body. Amount follows Plaid's sign: positive is money leaving. */
export const ManualTransactionCreateSchema = z
  .object({
    accountId: z.string().uuid(),
    amount: z
      .string()
      .regex(/^-?\d{1,12}$/, "Integer cents as a string, up to 12 digits"),
    date: isoDate,
    name: z.string().trim().min(1).max(200),
    merchantName: z.string().trim().min(1).max(200).nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type ManualTransactionCreate = z.infer<
  typeof ManualTransactionCreateSchema
>;

/** Required on POST /transactions: a client-generated UUID per logical create. */
export const IdempotencyKeyHeaderSchema = z.object({
  "idempotency-key": z.string().uuid(),
});

export const TransactionListResponseSchema = z.object({
  transactions: z.array(TransactionDtoSchema),
  nextCursor: z.string().nullable(),
});
/** Most similar transactions returned after a category change. */
export const SIMILAR_TRANSACTIONS_LIMIT = 100;
export const SimilarTransactionsResponseSchema = z.object({
  transactions: z.array(TransactionDtoSchema).max(SIMILAR_TRANSACTIONS_LIMIT),
});
export const TransactionDetailResponseSchema = z.object({
  transaction: TransactionDtoSchema,
});
export const TransactionDeleteResponseSchema = z.object({
  deleted: z.literal(true),
});
export const TransactionBulkPatchResponseSchema = z.object({
  updated: z.number().int(),
});
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
