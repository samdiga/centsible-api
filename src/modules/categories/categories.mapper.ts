import type { CategoryDto } from "./categories.schemas.js";
import type { CategoryRow } from "./categories.repository.js";

/** Converts a persistence row to the category wire DTO. */
export function toCategoryDto(row: CategoryRow): CategoryDto {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    icon: row.icon,
    color: row.color,
    isIncome: row.isIncome,
    isTransfer: row.isTransfer,
    excludeFromBudgets: row.excludeFromBudgets,
    displayOrder: row.displayOrder,
    isCustom: row.userId !== null,
  };
}
