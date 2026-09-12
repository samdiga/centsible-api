import { z } from "zod";

export const RuleIdSchema = z.string().uuid();
export const TagIdSchema = z.string().uuid();
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
  actionRename: z.string().nullable(),
  actionHide: z.boolean().nullable(),
  actionAddTagIds: z.array(TagIdSchema).nullable(),
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
  matchNameContains: z.string().min(1).optional(),
  matchAmountMin: MoneyCentsSchema.optional(),
  matchAmountMax: MoneyCentsSchema.optional(),
  matchAccountId: RuleIdSchema.optional(),
});
export type RulePreviewQuery = z.infer<typeof RulePreviewQuerySchema>;

const ActionFieldsSchema = z.object({
  actionCategoryId: RuleIdSchema.nullable(),
  actionMemberId: RuleIdSchema.nullable().optional(),
  actionSetNotes: z.string().max(500).nullable().optional(),
  actionMarkReviewed: z.boolean().nullable().optional(),
  actionExcludeFromBudgets: z.boolean().nullable().optional(),
  actionRename: z.string().max(200).nullable().optional(),
  actionHide: z.boolean().nullable().optional(),
  actionAddTagIds: z.array(TagIdSchema).max(20).nullable().optional(),
});

function hasAnyAction(value: {
  actionCategoryId: string | null;
  actionMemberId?: string | null | undefined;
  actionSetNotes?: string | null | undefined;
  actionMarkReviewed?: boolean | null | undefined;
  actionExcludeFromBudgets?: boolean | null | undefined;
  actionRename?: string | null | undefined;
  actionHide?: boolean | null | undefined;
  actionAddTagIds?: string[] | null | undefined;
}): boolean {
  return (
    !!value.actionCategoryId ||
    !!value.actionMemberId ||
    !!value.actionSetNotes ||
    !!value.actionMarkReviewed ||
    !!value.actionExcludeFromBudgets ||
    !!value.actionRename ||
    !!value.actionHide ||
    !!(value.actionAddTagIds && value.actionAddTagIds.length > 0)
  );
}

export const CreateRuleBodySchema = z
  .object({
    matchType: RuleMatchTypeSchema,
    matchMerchant: z.string().min(1).nullable().optional(),
    matchNameContains: z.string().min(1).nullable().optional(),
    matchAmountMin: MoneyCentsSchema.nullable().optional(),
    matchAmountMax: MoneyCentsSchema.nullable().optional(),
    matchAccountId: RuleIdSchema.nullable().optional(),
    name: z.string().max(100).optional(),
    applyToExisting: z.boolean().default(false),
  })
  .merge(ActionFieldsSchema)
  .refine(hasAnyAction, {
    message: "At least one action is required.",
  });
export type CreateRuleInput = z.infer<typeof CreateRuleBodySchema>;

export const UpdateRuleBodySchema = z
  .object({
    name: z.string().max(100),
    isActive: z.boolean(),
    priority: z.number().int().min(1).max(9999),
    matchType: RuleMatchTypeSchema,
    matchMerchant: z.string().min(1).nullable(),
    matchNameContains: z.string().min(1).nullable(),
    matchAmountMin: MoneyCentsSchema.nullable(),
    matchAmountMax: MoneyCentsSchema.nullable(),
    matchAccountId: RuleIdSchema.nullable(),
    actionCategoryId: RuleIdSchema.nullable(),
    actionMemberId: RuleIdSchema.nullable(),
    actionSetNotes: z.string().max(500).nullable(),
    actionMarkReviewed: z.boolean().nullable(),
    actionExcludeFromBudgets: z.boolean().nullable(),
    actionRename: z.string().max(200).nullable(),
    actionHide: z.boolean().nullable(),
    actionAddTagIds: z.array(TagIdSchema).max(20).nullable(),
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
export const RuleApplyResponseSchema = z.object({
  retroactiveJobId: RuleIdSchema,
});
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
