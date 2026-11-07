import type { SplitLine } from "./splits/split-math.js";
import type { TransactionDto } from "./transactions.schemas.js";
import type {
  TransactionListRow,
  TransactionRow,
} from "./transactions.repository.js";

/**
 * Converts persistence rows into the intentionally narrow transactions API
 * shape. `split.lines` are the transaction's category lines, if any; a
 * `detail` response lists them in full, a list row only their categories.
 */
export function toTransactionDto(
  row: TransactionListRow | TransactionRow,
  tagIds: string[],
  split: { lines?: readonly SplitLine[] | undefined; detail?: boolean } = {},
): TransactionDto {
  const lines = split.lines ?? [];
  return {
    id: row.id,
    accountId: row.accountId,
    amount: row.amount.toString(),
    currency: row.currency,
    date: row.date,
    status: row.status,
    name: row.name,
    merchantName: row.merchantName,
    paymentChannel: row.paymentChannel,
    plaidCategoryPrimary: row.plaidCategoryPrimary,
    plaidCategoryDetailed: row.plaidCategoryDetailed,
    categoryId: row.categoryId,
    userCategoryOverride: row.userCategoryOverride,
    isRecurring: row.isRecurring,
    reviewStatus: row.reviewStatus,
    userName: row.userName,
    notes: row.notes,
    tagIds,
    isManual: row.plaidTransactionId === null,
    splitOutOfBalance: row.splitOutOfBalance,
    ...(split.detail
      ? {
          splits: lines.map((line) => ({
            categoryId: line.categoryId,
            amount: line.amount.toString(),
            position: line.position,
            isRemainder: line.isRemainder,
          })),
        }
      : lines.length > 0
        ? { splitCategoryIds: lines.map((line) => line.categoryId) }
        : {}),
  };
}
