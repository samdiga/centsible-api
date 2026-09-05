import { z } from "zod";

const UuidSchema = z.string().uuid();
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const MoneyCentsSchema = z.string().regex(/^-?\d+$/);
export const MoneyCentsInputSchema = MoneyCentsSchema;

export const BudgetPeriodSchema = z.enum(["monthly", "biweekly", "weekly"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

export const BudgetItemDtoSchema = z.object({
  id: UuidSchema,
  budgetId: UuidSchema,
  categoryId: UuidSchema,
  categoryName: z.string(),
  amountCents: MoneyCentsSchema,
});
export type BudgetItemDto = z.infer<typeof BudgetItemDtoSchema>;
export const BudgetItemDTOSchema = BudgetItemDtoSchema;
export type BudgetItemDTO = BudgetItemDto;

export const BudgetDtoSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  period: BudgetPeriodSchema,
  startDate: IsoDateSchema,
  isActive: z.boolean(),
  items: z.array(BudgetItemDtoSchema),
  createdAt: IsoDateTimeSchema,
});
export type BudgetDto = z.infer<typeof BudgetDtoSchema>;
export const BudgetDTOSchema = BudgetDtoSchema;
export type BudgetDTO = BudgetDto;

export const BudgetProgressItemSchema = z.object({
  categoryId: UuidSchema,
  categoryName: z.string(),
  budgetedCents: MoneyCentsSchema,
  spentCents: MoneyCentsSchema,
  remainingCents: MoneyCentsSchema,
});
export type BudgetProgressItem = z.infer<typeof BudgetProgressItemSchema>;

export const BudgetProgressSchema = z.object({
  periodStart: IsoDateSchema,
  periodEnd: IsoDateSchema,
  totalBudgetedCents: MoneyCentsSchema,
  totalSpentCents: MoneyCentsSchema,
  items: z.array(BudgetProgressItemSchema),
});
export type BudgetProgress = z.infer<typeof BudgetProgressSchema>;

export const BudgetSuggestionSchema = z.object({
  categoryId: UuidSchema,
  categoryName: z.string(),
  medianCents: MoneyCentsSchema,
});
export type BudgetSuggestion = z.infer<typeof BudgetSuggestionSchema>;

export const BudgetSuggestionsResponseSchema = z.object({
  suggestions: z.array(BudgetSuggestionSchema),
});
export const BudgetActiveResponseSchema = z.object({ budget: BudgetDtoSchema });
export const BudgetProgressResponseSchema = z.object({
  progress: BudgetProgressSchema,
});
export const BudgetCreateResponseSchema = z.object({ id: UuidSchema });
export const BudgetUpdatedResponseSchema = z.object({
  updated: z.literal(true),
});
export const BudgetDeletedResponseSchema = z.object({ deleted: z.boolean() });
export const BudgetItemResponseSchema = z.object({
  item: z.object({
    id: UuidSchema,
    budgetId: UuidSchema,
    categoryId: UuidSchema,
    amountCents: MoneyCentsSchema,
  }),
});

export const CreateBudgetItemInputSchema = z.object({
  categoryId: UuidSchema,
  amountCents: MoneyCentsInputSchema,
});
export const CreateBudgetBodySchema = z.object({
  name: z.string().max(100).optional(),
  items: z.array(CreateBudgetItemInputSchema).min(1),
});
export type CreateBudgetBody = z.infer<typeof CreateBudgetBodySchema>;
export const ReplaceBudgetItemsBodySchema = z.object({
  items: z.array(CreateBudgetItemInputSchema).min(1),
});
export type ReplaceBudgetItemsBody = z.infer<
  typeof ReplaceBudgetItemsBodySchema
>;
export const UpsertBudgetItemBodySchema = z.object({
  amountCents: MoneyCentsInputSchema,
});
export type UpsertBudgetItemBody = z.infer<typeof UpsertBudgetItemBodySchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
