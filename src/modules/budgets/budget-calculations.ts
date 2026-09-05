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
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const anchor = Math.min(anchorDay, daysInMonth);
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
