import { z } from "zod";

const MoneyCentsSchema = z.string().regex(/^-?\d+$/);

export const ReportTypeSchema = z.enum([
  "spending_by_category",
  "monthly_spending",
  "income_vs_spending",
  "net_worth",
  "category_trend",
]);
export type ReportType = z.infer<typeof ReportTypeSchema>;

const TagIdsQuerySchema = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )
  .refine((ids) => ids.every((id) => z.string().uuid().safeParse(id).success), {
    message: "tagIds must be a comma-separated list of UUIDs",
  })
  .refine((ids) => ids.length <= 50, {
    message: "tagIds accepts at most 50 ids",
  });

export const ReportQuerySchema = z
  .object({
    type: ReportTypeSchema,
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tagIds: TagIdsQuerySchema.optional(),
  })
  .refine((query) => query.dateFrom <= query.dateTo, {
    message: "dateTo must not be before dateFrom",
    path: ["dateTo"],
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
/** `categoryId: "other"` is a synthetic sentinel, not a real category row. */
export const CategoryTrendReportSchema = z.object({
  type: z.literal("category_trend"),
  categories: z.array(
    z.object({
      categoryId: z.string(),
      name: z.string(),
      months: z.array(
        z.object({ month: z.string(), totalCents: MoneyCentsSchema }),
      ),
    }),
  ),
});
export const ReportSummaryResponseSchema = z.discriminatedUnion("type", [
  SpendingByCategoryReportSchema,
  MonthlySpendingReportSchema,
  IncomeVsSpendingReportSchema,
  NetWorthReportSchema,
  CategoryTrendReportSchema,
]);
export type ReportSummary = z.infer<typeof ReportSummaryResponseSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
