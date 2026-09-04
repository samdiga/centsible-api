import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../platform/errors/app-error.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  getUserRevision,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { BadCursorError } from "../../shared/pagination/cursor.js";
import { toTransactionDto } from "./transactions.mapper.js";
import {
  transactionRepository,
  type ExportFilters,
  type TransactionPatchFields,
  type TransactionRepository,
} from "./transactions.repository.js";
import type {
  TransactionBulkPatch,
  TransactionDto,
  TransactionListQuery,
} from "./transactions.schemas.js";

export class TransactionBadCursorError extends BadRequestError {
  constructor(message: string) {
    super("BAD_CURSOR", message);
  }
}

export type TransactionService = Readonly<{
  listTransactions: (
    userId: string,
    query: TransactionListQuery,
  ) => Promise<{ transactions: TransactionDto[]; nextCursor: string | null }>;
  getTransaction: (userId: string, id: string) => Promise<TransactionDto>;
  patchTransaction: (
    userId: string,
    id: string,
    patch: TransactionPatchFields,
  ) => Promise<TransactionDto>;
  bulkPatchTransactions: (
    userId: string,
    body: TransactionBulkPatch,
  ) => Promise<number>;
  exportTransactionsCsv: (
    userId: string,
    filters: ExportFilters,
  ) => Promise<{ csv: string; truncated: boolean }>;
}>;

export type TransactionServiceDependencies = Readonly<{
  repository?: TransactionRepository;
  cache?: Pick<ResponseCache, "getOrCompute" | "invalidateUser">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
}>;

function defaultMutation(
  cache: Pick<ResponseCache, "invalidateUser">,
): UserMutationService["withUserMutation"] {
  return createWithUserMutation({ db: getDb(), cache });
}

function assertPatchNotEmpty(patch: TransactionPatchFields): void {
  if (Object.keys(patch).length === 0) {
    throw new BadRequestError("BAD_REQUEST", "At least one field is required");
  }
}

async function assertPatchOwnership(
  repository: TransactionRepository,
  userId: string,
  patch: TransactionPatchFields,
  tx?: DbTransaction,
): Promise<void> {
  if (
    patch.categoryId != null &&
    !(await repository.categoryExists(userId, patch.categoryId, tx))
  ) {
    throw new ValidationError(
      "categoryId does not exist or is not accessible to this user.",
    );
  }
  if (
    patch.householdMemberId != null &&
    !(await repository.householdMemberExists(
      userId,
      patch.householdMemberId,
      tx,
    ))
  ) {
    throw new ValidationError(
      "householdMemberId does not exist or is not accessible to this user.",
    );
  }
}

function csvEscape(value: string): string {
  const safe = /^[=+\-@\t|]/.test(value) ? `'${value}` : value;
  return safe.includes(",") ||
    safe.includes('"') ||
    safe.includes("\n") ||
    safe.includes("\r")
    ? `"${safe.replaceAll('"', '""')}"`
    : safe;
}

function listCacheQuery(query: TransactionListQuery): Record<string, string[]> {
  return {
    limit: [String(query.limit ?? 50)],
    ...(query.accountId === undefined ? {} : { accountId: [query.accountId] }),
    ...(query.dateFrom === undefined ? {} : { dateFrom: [query.dateFrom] }),
    ...(query.dateTo === undefined ? {} : { dateTo: [query.dateTo] }),
    ...(query.q === undefined ? {} : { q: [query.q] }),
  };
}

export function createTransactionService(
  dependencies: TransactionServiceDependencies = {},
): TransactionService {
  const repository = dependencies.repository ?? transactionRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    ((userId, callback) => defaultMutation(cache)(userId, callback));

  return {
    async listTransactions(userId, query) {
      const read = async () => {
        try {
          const page = await repository.listByUser({
            userId,
            limit: query.limit ?? 50,
            cursor: query.cursor,
            filters: {
              accountId: query.accountId,
              dateFrom: query.dateFrom,
              dateTo: query.dateTo,
              q: query.q,
            },
          });
          return {
            transactions: page.rows.map(toTransactionDto),
            nextCursor: page.nextCursor,
          };
        } catch (error) {
          if (error instanceof BadCursorError)
            throw new TransactionBadCursorError(error.message);
          throw error;
        }
      };
      // Cursor pages are deliberately uncached; their correctness depends on
      // the cursor's exact point in the user-specific ordering.
      if (query.cursor) return read();
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/transactions",
          query: listCacheQuery(query),
          revision,
        },
        read,
      );
    },
    async getTransaction(userId, id) {
      const row = await repository.findById(id, userId);
      if (!row) throw new NotFoundError("transaction");
      return toTransactionDto(row);
    },
    async patchTransaction(userId, id, patch) {
      assertPatchNotEmpty(patch);
      const updated = await mutate(userId, async (tx) => {
        await assertPatchOwnership(repository, userId, patch, tx);
        const before = await repository.findById(id, userId, tx);
        if (!before) throw new NotFoundError("transaction");
        const row = await repository.updateTransaction(id, userId, patch, tx);
        if (!row) throw new NotFoundError("transaction");
        await repository.recordAudit(
          {
            userId,
            entityId: id,
            source: "transactions.patch",
            before,
            after: row,
          },
          tx,
        );
        return row;
      });
      return toTransactionDto(updated);
    },
    async bulkPatchTransactions(userId, body) {
      return mutate(userId, async (tx) => {
        await assertPatchOwnership(repository, userId, body.patch, tx);
        const updated = await repository.bulkUpdateTransactions(
          body.ids,
          userId,
          body.patch,
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityId: body.ids[0]!,
            source: "transactions.bulk_patch",
            before: { ids: body.ids, patch: body.patch },
          },
          tx,
        );
        return updated;
      });
    },
    async exportTransactionsCsv(userId, filters) {
      const { rows, truncated } = await repository.listAllForExport(
        userId,
        filters,
      );
      const header =
        "Date,Name,Merchant,Account,Category,Amount,Currency,Status";
      const lines = rows.map((row) =>
        [
          row.date,
          csvEscape(row.name),
          csvEscape(row.merchantName ?? ""),
          csvEscape(row.accountId),
          csvEscape(row.categoryId ?? ""),
          (-Number(row.amount) / 100).toFixed(2),
          row.currency ?? "USD",
          row.reviewStatus ?? "",
        ].join(","),
      );
      return { csv: [header, ...lines].join("\n"), truncated };
    },
  };
}
