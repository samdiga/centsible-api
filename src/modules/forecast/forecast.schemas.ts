import { z } from "zod";

const MoneyCentsSchema = z.string().regex(/^-?\d+$/);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ForecastHorizonSchema = z.coerce
  .number()
  .int()
  .refine((value): value is 14 | 30 | 60 | 90 =>
    [14, 30, 60, 90].includes(value),
  );
export type ForecastHorizon = z.infer<typeof ForecastHorizonSchema>;

export const ForecastQuerySchema = z.object({
  horizonDays: ForecastHorizonSchema.default(30),
});
export type ForecastQuery = z.infer<typeof ForecastQuerySchema>;

export const ForecastEventSchema = z.object({
  name: z.string(),
  amountCents: MoneyCentsSchema,
  confidence: z.number().min(0).max(1),
  sourceType: z.enum(["recurring", "manual", "pending_transaction"]),
  sourceId: z.string().optional(),
  recurringSeriesId: z.string().uuid().nullable().optional(),
});

export const ForecastDaySchema = z.object({
  date: IsoDateSchema,
  p50Cents: MoneyCentsSchema,
  p10Cents: MoneyCentsSchema,
  p90Cents: MoneyCentsSchema,
  events: z.array(ForecastEventSchema),
});

export const ForecastResponseSchema = z.object({
  days: z.array(ForecastDaySchema),
  tightestDay: z.object({
    date: IsoDateSchema,
    balanceCents: MoneyCentsSchema,
  }),
  algorithmVersion: z.literal("v1"),
  horizonDays: z.number().int(),
});
export type ForecastResponse = z.infer<typeof ForecastResponseSchema>;

export const ForecastAccuracyResponseSchema = z.object({
  mape30d: z.number().nullable(),
  runCount: z.number().int().nonnegative(),
});
export type ForecastAccuracyResponse = z.infer<
  typeof ForecastAccuracyResponseSchema
>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
