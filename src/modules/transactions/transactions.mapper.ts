import type { TransactionDto } from "./transactions.schemas.js";
import type {
  TransactionListRow,
  TransactionRow,
} from "./transactions.repository.js";

/** Converts persistence rows into the intentionally narrow transactions API shape. */
export function toTransactionDto(
  row: TransactionListRow | TransactionRow,
  tagIds: string[],
): TransactionDto {
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
  };
}
