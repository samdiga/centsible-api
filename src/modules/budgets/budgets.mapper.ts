import { centsToWire } from "../../shared/money/money.js";
import type { BudgetItemRow, BudgetRow } from "./budgets.repository.js";
import type { BudgetDto, BudgetItemDto } from "./budgets.schemas.js";

export function toBudgetItemDto(
  row: BudgetItemRow & { categoryName: string },
): BudgetItemDto {
  return {
    id: row.id,
    budgetId: row.budgetId,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    amountCents: centsToWire(row.amount)!,
  };
}

export function toBudgetDto(
  row: BudgetRow,
  items: Array<BudgetItemRow & { categoryName: string }>,
): BudgetDto {
  return {
    id: row.id,
    name: row.name,
    period: row.period,
    startDate: row.startDate,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    items: items.map(toBudgetItemDto),
  };
}
