import type { BudgetPeriod } from "./budgets.schemas.js";

export type BudgetItemInput = { categoryId: string; amountCents: bigint };
export type TransactionInput = {
  categoryId: string | null;
  amountCents: bigint;
};
export type ProgressResult = {
  categoryId: string;
  budgetedCents: bigint;
  spentCents: bigint;
  remainingCents: bigint;
};

export function effectiveMonthlyAnchorDay(
  anchorDay: number,
  year: number,
  month: number,
): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(anchorDay, daysInMonth);
}

export function currentPeriodRange(
  startDate: string,
  period: BudgetPeriod,
  today: Date = new Date(),
): { start: string; end: string } {
  const anchorDay = Number.parseInt(startDate.slice(8, 10), 10);
  if (period !== "monthly") {
    throw new Error(`Budget period "${period}" not yet implemented`);
  }

  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  // A 31st-anchor budget uses February 28/29 as its effective anchor.
  const anchor = effectiveMonthlyAnchorDay(anchorDay, year, month);
  let periodYear = year;
  let periodMonth = month;
  if (day < anchor) {
    periodMonth -= 1;
    if (periodMonth === 0) {
      periodMonth = 12;
      periodYear -= 1;
    }
  }

  const pad = (value: number) => String(value).padStart(2, "0");
  const daysInPeriodMonth = new Date(
    Date.UTC(periodYear, periodMonth, 0),
  ).getUTCDate();
  const startDay = Math.min(anchorDay, daysInPeriodMonth);
  const start = `${periodYear}-${pad(periodMonth)}-${pad(startDay)}`;

  let nextMonth = periodMonth + 1;
  let nextYear = periodYear;
  if (nextMonth === 13) {
    nextMonth = 1;
    nextYear += 1;
  }
  const daysInNextMonth = new Date(
    Date.UTC(nextYear, nextMonth, 0),
  ).getUTCDate();
  const nextStart = new Date(
    Date.UTC(nextYear, nextMonth - 1, Math.min(anchorDay, daysInNextMonth)),
  );
  nextStart.setUTCDate(nextStart.getUTCDate() - 1);
  return { start, end: nextStart.toISOString().slice(0, 10) };
}

export function budgetProgress(
  budgeted: BudgetItemInput[],
  transactions: TransactionInput[],
): ProgressResult[] {
  const spent = new Map<string, bigint>();
  for (const transaction of transactions) {
    if (!transaction.categoryId || transaction.amountCents <= 0n) continue;
    spent.set(
      transaction.categoryId,
      (spent.get(transaction.categoryId) ?? 0n) + transaction.amountCents,
    );
  }
  return budgeted.map((item) => {
    const spentCents = spent.get(item.categoryId) ?? 0n;
    return {
      categoryId: item.categoryId,
      budgetedCents: item.amountCents,
      spentCents,
      remainingCents: item.amountCents - spentCents,
    };
  });
}

/** The calendar month `YYYY-MM` as its first and last day. */
export function monthRange(month: string): { start: string; end: string } {
  const year = Number.parseInt(month.slice(0, 4), 10);
  const monthIndex = Number.parseInt(month.slice(5, 7), 10);
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export type UsageEntry = {
  categoryId: string;
  parentId: string | null;
  plannedCents: bigint | null;
  spentCents: bigint;
};

/**
 * One entry per category with a plan or non-zero spend, each its own amounts
 * (the app rolls groups up). Paused items plan nothing; `planned` is null
 * outright when the month isn't covered by a budget.
 */
export function budgetUsageEntries(input: {
  items: ReadonlyArray<{
    categoryId: string;
    amountCents: bigint;
    isPaused: boolean;
  }> | null;
  spent: ReadonlyArray<{ categoryId: string; spentCents: bigint }>;
  parents: ReadonlyMap<string, string | null>;
}): UsageEntry[] {
  const planned = new Map<string, bigint>();
  for (const item of input.items ?? []) {
    if (item.isPaused) continue;
    planned.set(
      item.categoryId,
      (planned.get(item.categoryId) ?? 0n) + item.amountCents,
    );
  }
  const spent = new Map(
    input.spent.map((row) => [row.categoryId, row.spentCents]),
  );
  const ids = new Set([...planned.keys(), ...spent.keys()]);
  return [...ids]
    .map((categoryId) => ({
      categoryId,
      parentId: input.parents.get(categoryId) ?? null,
      plannedCents: planned.get(categoryId) ?? null,
      spentCents: spent.get(categoryId) ?? 0n,
    }))
    .filter((entry) => entry.plannedCents !== null || entry.spentCents !== 0n)
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId));
}
