import { describe, expect, it } from "vitest";

import {
  CategoryTrendReportSchema,
  ReportQuerySchema,
  ReportSummaryResponseSchema,
} from "../reports.schemas.js";

describe("ReportQuerySchema", () => {
  it("accepts a query with no tagIds", () => {
    const result = ReportQuerySchema.safeParse({
      type: "spending_by_category",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tagIds).toBeUndefined();
  });

  it("parses a comma-separated tagIds string into an array of UUIDs", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const result = ReportQuerySchema.safeParse({
      type: "spending_by_category",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      tagIds: `${a},${b}`,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tagIds).toEqual([a, b]);
  });

  it("rejects tagIds containing a non-UUID entry", () => {
    const result = ReportQuerySchema.safeParse({
      type: "spending_by_category",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      tagIds: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts category_trend as a report type", () => {
    const result = ReportQuerySchema.safeParse({
      type: "category_trend",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
    });
    expect(result.success).toBe(true);
  });

  it("rejects dateTo before dateFrom", () => {
    const result = ReportQuerySchema.safeParse({
      type: "spending_by_category",
      dateFrom: "2026-05-31",
      dateTo: "2026-05-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts dateTo equal to dateFrom", () => {
    const result = ReportQuerySchema.safeParse({
      type: "spending_by_category",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-01",
    });
    expect(result.success).toBe(true);
  });
});

describe("CategoryTrendReportSchema", () => {
  it("accepts a category list with an 'other' sentinel row", () => {
    const result = CategoryTrendReportSchema.safeParse({
      type: "category_trend",
      categories: [
        {
          categoryId: "11111111-1111-4111-8111-111111111111",
          name: "Groceries",
          months: [{ month: "2026-05", totalCents: "1250" }],
        },
        {
          categoryId: "other",
          name: "Other",
          months: [{ month: "2026-05", totalCents: "400" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("ReportSummaryResponseSchema", () => {
  it("discriminates category_trend as its own member", () => {
    const result = ReportSummaryResponseSchema.safeParse({
      type: "category_trend",
      categories: [],
    });
    expect(result.success).toBe(true);
  });
});
