import { z } from "zod";

export const RuleIdSchema = z.string().uuid();
export const RuleMatchTypeSchema = z.enum([
  "merchant_exact",
  "merchant_contains",
  "name_contains",
  "amount_exact",
  "amount_range",
  "combo",
]);
export type RuleMatchType = z.infer<typeof RuleMatchTypeSchema>;

export const MoneyCentsSchema = z.string().regex(/^-?\d+$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const RuleDtoSchema = z.object({
  id: RuleIdSchema,
  name: z.string().nullable(),
  priority: z.number().int(),
  matchType: RuleMatchTypeSchema,
  matchMerchant: z.string().nullable(),
  matchNameContains: z.string().nullable(),
  matchAmountMin: MoneyCentsSchema.nullable(),
  matchAmountMax: MoneyCentsSchema.nullable(),
  matchAccountId: RuleIdSchema.nullable(),
  actionCategoryId: RuleIdSchema.nullable(),
  actionMemberId: RuleIdSchema.nullable(),
  actionSetNotes: z.string().nullable(),
  actionMarkReviewed: z.boolean().nullable(),
  actionExcludeFromBudgets: z.boolean().nullable(),
  isActive: z.boolean(),
  applyToExisting: z.boolean(),
  timesApplied: z.number().int(),
  lastAppliedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type RuleDto = z.infer<typeof RuleDtoSchema>;

export const RuleListResponseSchema = z.object({
  rules: z.array(RuleDtoSchema),
});
export const RulePreviewQuerySchema = z.object({
  matchType: RuleMatchTypeSchema,
  matchMerchant: z.string().min(1).optional(),
});
export type RulePreviewQuery = z.infer<typeof RulePreviewQuerySchema>;

export const CreateRuleBodySchema = z.object({
  matchType: RuleMatchTypeSchema,
  matchMerchant: z.string().min(1).nullable().optional(),
  matchNameContains: z.string().min(1).nullable().optional(),
  matchAmountMin: MoneyCentsSchema.nullable().optional(),
  matchAmountMax: MoneyCentsSchema.nullable().optional(),
  matchAccountId: RuleIdSchema.nullable().optional(),
  actionCategoryId: RuleIdSchema.nullable(),
  actionMemberId: RuleIdSchema.nullable().optional(),
  actionSetNotes: z.string().max(500).nullable().optional(),
  actionMarkReviewed: z.boolean().nullable().optional(),
  actionExcludeFromBudgets: z.boolean().nullable().optional(),
  name: z.string().max(100).optional(),
  applyToExisting: z.boolean().default(false),
});
export type CreateRuleInput = z.infer<typeof CreateRuleBodySchema>;

export const UpdateRuleBodySchema = z
  .object({
    name: z.string().max(100),
    isActive: z.boolean(),
    priority: z.number().int().min(1).max(9999),
    actionCategoryId: RuleIdSchema.nullable(),
    actionMemberId: RuleIdSchema.nullable(),
    matchAccountId: RuleIdSchema.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field required",
  });
export type UpdateRuleInput = z.infer<typeof UpdateRuleBodySchema>;

export const RuleCreateResponseSchema = z.object({
  rule: RuleDtoSchema,
  retroactiveJobId: RuleIdSchema.nullable(),
});
export const RuleUpdateResponseSchema = z.object({ rule: RuleDtoSchema });
export const RuleDeleteResponseSchema = z.object({ deleted: z.literal(true) });
export const RulePreviewResponseSchema = z.object({ count: z.number().int() });
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
