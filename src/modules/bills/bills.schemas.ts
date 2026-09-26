import { z } from "zod";

export const BillIdSchema = z.string().uuid();
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const MoneyCentsInputSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform((value) => BigInt(value));
export const MoneyCentsSchema = z.string().regex(/^-?\d+$/);

export const BillCadenceSchema = z.enum([
  "daily",
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
  "quarterly",
  "annual",
  "irregular",
]);
export const BillSetupStatusSchema = z.enum([
  "active",
  "paused",
  "ended",
  "pending_confirmation",
]);
export const BillOccurrenceStatusSchema = z.enum([
  "upcoming",
  "overdue",
  "processing",
  "paid",
  "skipped",
  "cancelled",
]);

export const BillOccurrenceDtoSchema = z.object({
  id: BillIdSchema,
  billSetupId: BillIdSchema,
  dueDate: IsoDateSchema,
  status: BillOccurrenceStatusSchema,
  expectedAmountCents: MoneyCentsSchema,
  paidAmountCents: MoneyCentsSchema.nullable(),
  paidAccountId: BillIdSchema.nullable(),
  linkedTransactionId: BillIdSchema.nullable(),
  markedPaidAt: IsoDateTimeSchema.nullable(),
  confirmedPaidAt: IsoDateTimeSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type BillOccurrenceDto = z.infer<typeof BillOccurrenceDtoSchema>;

export const BillDtoSchema = z.object({
  id: BillIdSchema,
  canonicalName: z.string(),
  cadence: BillCadenceSchema,
  status: BillSetupStatusSchema,
  avgAmountCents: MoneyCentsSchema,
  lastAmountCents: MoneyCentsSchema.nullable(),
  nextExpectedDate: IsoDateSchema.nullable(),
  lastOccurredOn: IsoDateSchema.nullable(),
  categoryId: BillIdSchema.nullable(),
  billType: z.enum(["payable", "transfer"]),
  accountId: BillIdSchema.nullable(),
  toAccountId: BillIdSchema.nullable(),
  confidence: z.number(),
  sampleCount: z.number().int(),
  userConfirmed: z.boolean(),
  lastPriceChangeAt: IsoDateTimeSchema.nullable(),
  previousAvgAmountCents: MoneyCentsSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  currentOccurrence: BillOccurrenceDtoSchema.nullable().optional(),
});
export type BillDto = z.infer<typeof BillDtoSchema>;

export const BillListResponseSchema = z.object({
  series: z.array(BillDtoSchema),
  pendingCount: z.number().int(),
});
export const BillDetailResponseSchema = z.object({ series: BillDtoSchema });
export const BillMutateResponseSchema = z.object({ series: BillDtoSchema });
export const BillOccurrenceListResponseSchema = z.object({
  occurrences: z.array(BillOccurrenceDtoSchema),
});
export const BillQueuedResponseSchema = z.object({ queued: z.literal(true) });
export const BillActionResponseSchema = z.object({ ok: z.literal(true) });
export const BillDeletedResponseSchema = z.object({ deleted: z.literal(true) });

export const CreateBillBodySchema = z.object({
  canonicalName: z.string().min(1).max(120),
  amountCents: MoneyCentsInputSchema.refine(
    (value) => value > 0n,
    "Amount must be positive",
  ),
  cadence: BillCadenceSchema,
  nextExpectedDate: IsoDateSchema,
  categoryId: BillIdSchema.nullable().optional(),
  accountId: BillIdSchema.nullable().optional(),
  isIncome: z.boolean().optional().default(false),
  billType: z.enum(["payable", "transfer"]).optional().default("payable"),
  toAccountId: BillIdSchema.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export type CreateBillInput = z.infer<typeof CreateBillBodySchema>;

export const UpdateBillBodySchema = z
  .object({
    status: z.enum(["active", "paused", "ended"]),
    userConfirmed: z.boolean(),
    categoryId: BillIdSchema.nullable(),
    accountId: BillIdSchema.nullable(),
    billType: z.enum(["payable", "transfer"]),
    toAccountId: BillIdSchema.nullable(),
    notes: z.string().max(500).nullable(),
  })
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field required",
  );
export type UpdateBillInput = z.infer<typeof UpdateBillBodySchema>;

export const MarkBillPaidBodySchema = z.object({
  accountId: BillIdSchema,
  amountCents: MoneyCentsInputSchema.refine(
    (value) => value > 0n,
    "Amount must be positive",
  ),
});
export type MarkBillPaidInput = z.infer<typeof MarkBillPaidBodySchema>;

const CalendarDateSchema = z.string().refine((value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (daysInMonth[month - 1] ?? 0);
}, "Expected a real ISO calendar date");

export const UpdateBillOccurrenceBodySchema = z
  .object({
    amountCents: z
      .string()
      .regex(/^\d+$/)
      .transform((value) => BigInt(value))
      .refine((value) => value > 0n, "Amount must be positive"),
    dueDate: CalendarDateSchema,
  })
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field required",
  );
export type UpdateBillOccurrenceInput = z.infer<
  typeof UpdateBillOccurrenceBodySchema
>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
