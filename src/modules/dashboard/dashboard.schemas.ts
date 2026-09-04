import { z } from "zod";

const MoneyCentsSchema = z.string().regex(/^-?\d+$/);

export const UpcomingBillSchema = z.object({
  id: z.string().uuid(),
  canonicalName: z.string(),
  nextExpectedDate: z.string(),
  avgAmount: MoneyCentsSchema,
  cadence: z.string(),
});
export type UpcomingBill = z.infer<typeof UpcomingBillSchema>;

export const DashboardSummarySchema = z.object({
  netWorth: MoneyCentsSchema,
  assets: MoneyCentsSchema,
  liabilities: MoneyCentsSchema,
  safeToSpend: MoneyCentsSchema,
  safeToSpendHasBills: z.boolean(),
  spendingThisMonth: MoneyCentsSchema,
  spendingLastMonth: MoneyCentsSchema,
  upcomingBills: z.array(UpcomingBillSchema),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

export const DashboardSummaryResponseSchema = DashboardSummarySchema;
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
