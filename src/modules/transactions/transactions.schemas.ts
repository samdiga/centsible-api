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
  amount: z.string(),
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
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: "At least one patch field required",
    }),
});
export type TransactionBulkPatch = z.infer<typeof TransactionBulkPatchSchema>;

export const TransactionListResponseSchema = z.object({
  transactions: z.array(TransactionDtoSchema),
  nextCursor: z.string().nullable(),
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
