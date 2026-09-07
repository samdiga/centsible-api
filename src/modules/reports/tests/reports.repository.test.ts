import { describe, expect, it, vi } from "vitest";

import { createReportsRepository } from "../reports.repository.js";

describe("reports repository aggregate boundaries", () => {
  it("normalizes string aggregates to bigint for every report path", async () => {
    const aggregateRows: unknown[][] = [
      [{ categoryId: "category-id", name: "Food", totalCents: "1250" }],
      [{ month: "2026-05", totalCents: "1250" }],
      [{ month: "2026-05", totalCents: "4000" }],
      [{ month: "2026-05", netWorthCents: "100000" }],
    ];
    type Query = {
      from: () => Query;
      leftJoin: () => Query;
      where: () => Query;
      groupBy: () => Query;
      orderBy: () => Promise<unknown[]>;
    };
    const query: Query = {
      from: () => query,
      leftJoin: () => query,
      where: () => query,
      groupBy: () => query,
      orderBy: vi.fn(async () => aggregateRows.shift() ?? []),
    };
    const repository = createReportsRepository({
      select: vi.fn(() => query),
    } as never);

    await expect(
      repository.getSpendingByCategory("user-id", "2026-05-01", "2026-05-31"),
    ).resolves.toEqual([
      { categoryId: "category-id", name: "Food", totalCents: 1250n },
    ]);
    await expect(
      repository.getMonthlySpending("user-id", "2026-05-01", "2026-05-31"),
    ).resolves.toEqual([{ month: "2026-05", totalCents: 1250n }]);
    await expect(
      repository.getMonthlyIncome("user-id", "2026-05-01", "2026-05-31"),
    ).resolves.toEqual([{ month: "2026-05", totalCents: 4000n }]);
    await expect(
      repository.getNetWorthSnapshots("user-id", "2026-05-01", "2026-05-31"),
    ).resolves.toEqual([{ month: "2026-05", netWorthCents: 100000n }]);
  });
});
