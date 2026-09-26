import { z } from "zod";

export const TransactionIdSchema = z.string().uuid();
export const TransactionStatusSchema = z.enum(["posted", "pending", "removed"]);
export const ReviewStatusSchema = z.enum([
  "needs_review",
  "reviewed",
  "hidden",
]);

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
});
export type TransactionDto = z.infer<typeof TransactionDtoSchema>;

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
});
export type TransactionListQuery = z.infer<typeof TransactionListQuerySchema>;

export const TransactionPatchSchema = z
  .object({
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

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    { message: "Must be a real calendar date" },
  );

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
export const TransactionBulkPatchResponseSchema = z.object({
  updated: z.number().int(),
});
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
