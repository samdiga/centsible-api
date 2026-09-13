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

describe("reports repository tag filtering", () => {
  it("adds an EXISTS-style tag filter only when tagIds is non-empty", async () => {
    const whereCalls: unknown[] = [];
    type Query = {
      from: () => Query;
      leftJoin: () => Query;
      where: (condition: unknown) => Query;
      groupBy: () => Query;
      orderBy: () => Promise<unknown[]>;
    };
    const query: Query = {
      from: () => query,
      leftJoin: () => query,
      where: (condition) => {
        whereCalls.push(condition);
        return query;
      },
      groupBy: () => query,
      orderBy: vi.fn(async () => []),
    };
    const repository = createReportsRepository({
      select: vi.fn(() => query),
    } as never);

    await repository.getSpendingByCategory(
      "user-id",
      "2026-05-01",
      "2026-05-31",
    );
    const callsWithoutTagIds = whereCalls.length;

    await repository.getSpendingByCategory(
      "user-id",
      "2026-05-01",
      "2026-05-31",
      ["tag-a"],
    );

    // The tagIds call produces at least one additional .where(...) invocation
    // (the outer `and(...)` condition, plus the tag-membership subquery's own
    // `.where()` against the shared mock) — this asserts a tag filter changes
    // *something* about the condition passed, not exact SQL shape or call
    // count (that's the integration test's job).
    expect(whereCalls.length).toBeGreaterThan(callsWithoutTagIds);
  });
});

describe("getCategoryTrend", () => {
  it("normalizes two-query aggregate rows into a per-category month series", async () => {
    // The real implementation ends its first query with `.orderBy(...).limit(N)`
    // and its other two with `.orderBy(...)` awaited directly (no `.limit()`).
    // A single mock shape has to support both endings, so `orderBy()` returns
    // a "thenable query": awaitable on its own, and still chainable with
    // `.limit()` when the caller goes one step further.
    const responses: unknown[][] = [
      [{ categoryId: "cat-1", name: "Groceries", totalCents: "9000" }], // topCategories, via .limit()
      [{ categoryId: "cat-1", month: "2026-05", totalCents: "9000" }], // monthlyRows, via .orderBy() directly
      [{ month: "2026-05", totalCents: "400" }], // otherRows, via .orderBy() directly
    ];
    const nextResponse = () => responses.shift() ?? [];

    type ThenableQuery = PromiseLike<unknown[]> & {
      limit: () => Promise<unknown[]>;
    };
    type Query = {
      from: () => Query;
      leftJoin: () => Query;
      where: () => Query;
      groupBy: () => Query;
      orderBy: () => ThenableQuery;
    };
    const thenableQuery = (): ThenableQuery => ({
      limit: async () => nextResponse(),
      then: (resolve, reject) =>
        Promise.resolve(nextResponse()).then(resolve, reject),
    });
    const query: Query = {
      from: () => query,
      leftJoin: () => query,
      where: () => query,
      groupBy: () => query,
      orderBy: () => thenableQuery(),
    };
    const repository = createReportsRepository({
      select: vi.fn(() => query),
    } as never);

    const result = await repository.getCategoryTrend(
      "user-id",
      "2026-05-01",
      "2026-05-31",
    );

    expect(result).toEqual([
      {
        categoryId: "cat-1",
        name: "Groceries",
        months: [{ month: "2026-05", totalCents: 9000n }],
      },
      {
        categoryId: "other",
        name: "Other",
        months: [{ month: "2026-05", totalCents: 400n }],
      },
    ]);
  });
});
