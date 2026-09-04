import { z } from "zod";

const MoneyCentsSchema = z.string().regex(/^-?\d+$/);

export const ReportTypeSchema = z.enum([
  "spending_by_category",
  "monthly_spending",
  "income_vs_spending",
  "net_worth",
]);
export type ReportType = z.infer<typeof ReportTypeSchema>;

export const ReportQuerySchema = z.object({
  type: ReportTypeSchema,
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type ReportQuery = z.infer<typeof ReportQuerySchema>;

export const SpendingByCategoryReportSchema = z.object({
  type: z.literal("spending_by_category"),
  categories: z.array(
    z.object({
      categoryId: z.string(),
      name: z.string(),
      totalCents: MoneyCentsSchema,
    }),
  ),
});
export const MonthlySpendingReportSchema = z.object({
  type: z.literal("monthly_spending"),
  months: z.array(
    z.object({ month: z.string(), totalCents: MoneyCentsSchema }),
  ),
});
export const IncomeVsSpendingReportSchema = z.object({
  type: z.literal("income_vs_spending"),
  months: z.array(
    z.object({
      month: z.string(),
      incomeCents: MoneyCentsSchema,
      spendingCents: MoneyCentsSchema,
    }),
  ),
});
export const NetWorthReportSchema = z.object({
  type: z.literal("net_worth"),
  snapshots: z.array(
    z.object({ month: z.string(), netWorthCents: MoneyCentsSchema }),
  ),
});
export const ReportSummaryResponseSchema = z.discriminatedUnion("type", [
  SpendingByCategoryReportSchema,
  MonthlySpendingReportSchema,
  IncomeVsSpendingReportSchema,
  NetWorthReportSchema,
]);
export type ReportSummary = z.infer<typeof ReportSummaryResponseSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
