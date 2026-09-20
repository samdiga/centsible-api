import { describe, expect, it } from "vitest";

import {
  NetWorthHistoryQuerySchema,
  NetWorthHistoryResponseSchema,
} from "../dashboard.schemas.js";

describe("NetWorthHistoryQuerySchema", () => {
  it("accepts a valid daily query", () => {
    const result = NetWorthHistoryQuerySchema.safeParse({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      resolution: "daily",
    });
    expect(result.success).toBe(true);
  });

  it("accepts weekly and monthly resolutions", () => {
    for (const resolution of ["weekly", "monthly"]) {
      const result = NetWorthHistoryQuerySchema.safeParse({
        dateFrom: "2026-01-01",
        dateTo: "2026-08-31",
        resolution,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a missing resolution", () => {
    const result = NetWorthHistoryQuerySchema.safeParse({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown resolution value", () => {
    const result = NetWorthHistoryQuerySchema.safeParse({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      resolution: "yearly",
    });
    expect(result.success).toBe(false);
  });

  it("rejects dateTo before dateFrom", () => {
    const result = NetWorthHistoryQuerySchema.safeParse({
      dateFrom: "2026-08-31",
      dateTo: "2026-08-01",
      resolution: "daily",
    });
    expect(result.success).toBe(false);
  });

  it("accepts dateTo equal to dateFrom", () => {
    const result = NetWorthHistoryQuerySchema.safeParse({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
      resolution: "daily",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed date", () => {
    const result = NetWorthHistoryQuerySchema.safeParse({
      dateFrom: "08/01/2026",
      dateTo: "2026-08-31",
      resolution: "daily",
    });
    expect(result.success).toBe(false);
  });
});

describe("NetWorthHistoryResponseSchema", () => {
  it("accepts an empty points array", () => {
    const result = NetWorthHistoryResponseSchema.safeParse({ points: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed point", () => {
    const result = NetWorthHistoryResponseSchema.safeParse({
      points: [
        {
          date: "2026-08-15",
          netWorthCents: "1250000",
          assetsCents: "1500000",
          liabilitiesCents: "250000",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a point with a malformed date", () => {
    const result = NetWorthHistoryResponseSchema.safeParse({
      points: [
        {
          date: "not-a-date",
          netWorthCents: "0",
          assetsCents: "0",
          liabilitiesCents: "0",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
