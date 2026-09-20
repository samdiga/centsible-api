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

export const NetWorthResolutionSchema = z.enum(["daily", "weekly", "monthly"]);
export type NetWorthResolution = z.infer<typeof NetWorthResolutionSchema>;

export const NetWorthHistoryQuerySchema = z
  .object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    resolution: NetWorthResolutionSchema,
  })
  .refine((query) => query.dateFrom <= query.dateTo, {
    message: "dateTo must not be before dateFrom",
    path: ["dateTo"],
  });
export type NetWorthHistoryQuery = z.infer<typeof NetWorthHistoryQuerySchema>;

export const NetWorthHistoryPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  netWorthCents: MoneyCentsSchema,
  assetsCents: MoneyCentsSchema,
  liabilitiesCents: MoneyCentsSchema,
});
export const NetWorthHistoryResponseSchema = z.object({
  points: z.array(NetWorthHistoryPointSchema),
});
export type NetWorthHistoryResponse = z.infer<
  typeof NetWorthHistoryResponseSchema
>;
