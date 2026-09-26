import { createHash } from "node:crypto";

import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
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
import {
  manualBalanceDeltaCents,
  normalizeManualBalanceCents,
  type ManualAccountSubtype,
} from "../../shared/money/account-balance.js";
import {
  matchRules,
  ruleForMatching,
  rulesRepository,
  type RuleRepository,
} from "../rules/index.js";
import {
  manualTransactionRepository,
  type ManualAccountForWrite,
  type ManualTransactionRepository,
} from "./manual-transactions.repository.js";
import { rulePatch } from "./rule-patch.js";
import { toTransactionDto } from "./transactions.mapper.js";
import {
  transactionRepository,
  type ExportFilters,
  type TransactionPatchFields,
  type TransactionRepository,
  type TransactionRow,
} from "./transactions.repository.js";
import {
  SIMILAR_TRANSACTIONS_LIMIT,
  type TransactionBulkPatch,
  TransactionDtoSchema,
  type ManualTransactionCreate,
  type TransactionDto,
  type TransactionListQuery,
} from "./transactions.schemas.js";

export class TransactionBadCursorError extends BadRequestError {
  constructor(message: string) {
    super("BAD_CURSOR", message);
  }
}

/** Same Idempotency-Key, different body: the client reused a key it must not. */
export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used with a different request body",
      422,
    );
  }
}

const MANUAL_SUBTYPES: ReadonlySet<string> = new Set<ManualAccountSubtype>([
  "cash",
  "checking",
  "savings",
  "credit_card",
]);

/** Stable hash of the validated body, independent of key order and omitted optionals. */
function manualRequestHash(body: ManualTransactionCreate): string {
  const canonical = JSON.stringify([
    body.accountId,
    body.amount,
    body.date,
    body.name,
    body.merchantName ?? null,
    body.categoryId ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export type TransactionService = Readonly<{
  listTransactions: (
    userId: string,
    query: TransactionListQuery,
  ) => Promise<{ transactions: TransactionDto[]; nextCursor: string | null }>;
  getTransaction: (userId: string, id: string) => Promise<TransactionDto>;
  listSimilarTransactions: (
    userId: string,
    id: string,
  ) => Promise<TransactionDto[]>;
  patchTransaction: (
    userId: string,
    id: string,
    patch: TransactionPatchFields,
  ) => Promise<TransactionDto>;
  deleteManualTransaction: (userId: string, id: string) => Promise<void>;
  bulkPatchTransactions: (
    userId: string,
    body: TransactionBulkPatch,
  ) => Promise<number>;
  /**
   * POST /transactions with an Idempotency-Key: adds a transaction to a
   * manual account and moves its balance, exactly once per key.
   */
  createManualTransaction: (
    userId: string,
    idempotencyKey: string,
    body: ManualTransactionCreate,
  ) => Promise<{ transaction: TransactionDto; replayed: boolean }>;
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
  manualRepository?: ManualTransactionRepository;
  rules?: Pick<RuleRepository, "listActiveRules">;
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

function assertWritableManualAccount(
  account: ManualAccountForWrite,
): void {
  if (!account.isManual || !MANUAL_SUBTYPES.has(account.subtype))
    throw new UnprocessableError(
      "Transactions can only be changed on manual accounts.",
    );
  if (account.archivedAt)
    throw new ConflictError("Transactions on archived accounts cannot be changed.");
}

async function adjustEditedManualTransaction(input: {
  userId: string;
  before: TransactionRow;
  patch: TransactionPatchFields;
  manual: ManualTransactionRepository;
  transaction: DbTransaction;
}): Promise<void> {
  const { userId, before, patch, manual, transaction } = input;
  const destinationId = patch.accountId ?? before.accountId;
  // Always lock the affected accounts in stable order so opposite-direction
  // moves cannot deadlock while each reverses one balance and applies another.
  const accountIds = [...new Set([before.accountId, destinationId])].sort();
  const accounts = new Map<string, ManualAccountForWrite>();
  for (const accountId of accountIds) {
    const account = await manual.findAccountForWrite(
      userId,
      accountId,
      transaction,
    );
    if (!account) throw new NotFoundError("account");
    assertWritableManualAccount(account);
    accounts.set(accountId, account);
  }

  const source = accounts.get(before.accountId)!;
  const destination = accounts.get(destinationId)!;
  if (
    source.currency.toUpperCase() !== before.currency.toUpperCase() ||
    destination.currency.toUpperCase() !== before.currency.toUpperCase()
  )
    throw new UnprocessableError(
      "A transaction can only be changed on an account with the same currency.",
    );
  const oldAmountDelta = manualBalanceDeltaCents(
    source.subtype as ManualAccountSubtype,
    before.amount,
  );
  const newAmount = patch.amount ?? before.amount;
  const newAmountDelta = manualBalanceDeltaCents(
    destination.subtype as ManualAccountSubtype,
    newAmount,
  );

  if (source.id === destination.id) {
    const delta = newAmountDelta - oldAmountDelta;
    if (delta === 0n) return;
    const balanceAfter = await manual.adjustAccountBalance(
      userId,
      source.id,
      delta,
      transaction,
    );
    normalizeManualBalanceCents(
      source.subtype as ManualAccountSubtype,
      balanceAfter,
    );
    return;
  }

  const sourceBalance = await manual.adjustAccountBalance(
    userId,
    source.id,
    -oldAmountDelta,
    transaction,
  );
  normalizeManualBalanceCents(
    source.subtype as ManualAccountSubtype,
    sourceBalance,
  );

  const destinationBalance = await manual.adjustAccountBalance(
    userId,
    destination.id,
    newAmountDelta,
    transaction,
  );
  normalizeManualBalanceCents(
    destination.subtype as ManualAccountSubtype,
    destinationBalance,
  );
}

function hasManualEditableFields(patch: TransactionPatchFields): boolean {
  return ["amount", "date", "name", "merchantName", "accountId"].some(
    (field) => field in patch,
  );
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
  if (
    patch.tagIds !== undefined &&
    patch.tagIds.length > 0 &&
    !(await repository.tagsExist(userId, patch.tagIds, tx))
  ) {
    throw new ValidationError(
      "One or more tagIds do not exist or are not accessible to this user.",
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
  const manual = dependencies.manualRepository ?? manualTransactionRepository;
  const rules = dependencies.rules ?? rulesRepository;
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
          const tagsById = await repository.getTagIdsForTransactions(
            userId,
            page.rows.map((row) => row.id),
          );
          return {
            transactions: page.rows.map((row) =>
              toTransactionDto(row, tagsById.get(row.id) ?? []),
            ),
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
      const tagsById = await repository.getTagIdsForTransactions(userId, [id]);
      return toTransactionDto(row, tagsById.get(id) ?? []);
    },
    async listSimilarTransactions(userId, id) {
      const rows = await repository.listSimilarByMerchant({
        userId,
        transactionId: id,
        limit: SIMILAR_TRANSACTIONS_LIMIT,
      });
      if (!rows) throw new NotFoundError("transaction");
      const tagsById = await repository.getTagIdsForTransactions(
        userId,
        rows.map((row) => row.id),
      );
      return rows.map((row) =>
        toTransactionDto(row, tagsById.get(row.id) ?? []),
      );
    },
    async patchTransaction(userId, id, patch) {
      assertPatchNotEmpty(patch);
      const result = await mutate(userId, async (tx) => {
        await assertPatchOwnership(repository, userId, patch, tx);
        const before = await repository.findByIdForUpdate(id, userId, tx);
        if (!before) throw new NotFoundError("transaction");
        if (hasManualEditableFields(patch)) {
          if (before.plaidTransactionId !== null)
            throw new UnprocessableError(
              "Only manually entered transactions can change amount, date, name, merchant or account.",
            );
          await adjustEditedManualTransaction({
            userId,
            before,
            patch,
            manual,
            transaction: tx,
          });
        }
        const beforeTagsById = await repository.getTagIdsForTransactions(
          userId,
          [id],
          tx,
        );
        const beforeTagIds = beforeTagsById.get(id) ?? [];
        const row = await repository.updateTransaction(id, userId, patch, tx);
        if (!row) throw new NotFoundError("transaction");
        if (patch.tagIds !== undefined) {
          await repository.replaceTransactionTags(id, patch.tagIds, tx);
        }
        // Re-fetched after the replace above so a tag-only patch (no column
        // change on the transactions row) still shows up in the audit trail.
        const afterTagsById = await repository.getTagIdsForTransactions(
          userId,
          [id],
          tx,
        );
        const afterTagIds = afterTagsById.get(id) ?? [];
        await repository.recordAudit(
          {
            userId,
            entityId: id,
            source: "transactions.patch",
            before: { ...before, tagIds: beforeTagIds },
            after: { ...row, tagIds: afterTagIds },
          },
          tx,
        );
        return { row, tagIds: afterTagIds };
      });
      return toTransactionDto(result.row, result.tagIds);
    },
    async deleteManualTransaction(userId, id) {
      await mutate(userId, async (tx) => {
        const before = await repository.findByIdForUpdate(id, userId, tx);
        if (!before) throw new NotFoundError("transaction");
        if (before.plaidTransactionId !== null)
          throw new UnprocessableError(
            "Only manually entered transactions can be deleted.",
          );

        const account = await manual.findAccountForWrite(
          userId,
          before.accountId,
          tx,
        );
        if (!account) throw new NotFoundError("account");
        assertWritableManualAccount(account);
        if (account.currency.toUpperCase() !== before.currency.toUpperCase())
          throw new UnprocessableError(
            "A transaction can only be changed on an account with the same currency.",
          );

        const delta = manualBalanceDeltaCents(
          account.subtype as ManualAccountSubtype,
          before.amount,
        );
        const balanceAfter = await manual.adjustAccountBalance(
          userId,
          account.id,
          -delta,
          tx,
        );
        normalizeManualBalanceCents(
          account.subtype as ManualAccountSubtype,
          balanceAfter,
        );

        const deleted = await repository.softDeleteTransaction(id, userId, tx);
        if (!deleted) throw new NotFoundError("transaction");
        await repository.recordAudit(
          {
            userId,
            entityId: id,
            action: "delete",
            source: "transactions.manual_delete",
            before,
            after: { ...deleted, balanceAfterCents: balanceAfter.toString() },
          },
          tx,
        );
      });
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
        if (body.patch.tagIds !== undefined) {
          await repository.replaceTransactionTagsForMany(
            body.ids,
            body.patch.tagIds,
            tx,
          );
        }
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
    async createManualTransaction(userId, idempotencyKey, body) {
      const requestHash = manualRequestHash(body);
      return mutate(userId, async (tx) => {
        const claimed = await manual.claimIdempotencyKey(
          userId,
          idempotencyKey,
          requestHash,
          tx,
        );
        if (!claimed) {
          const stored = await manual.findIdempotencyKey(
            userId,
            idempotencyKey,
            tx,
          );
          if (stored && stored.requestHash !== requestHash)
            throw new IdempotencyKeyReusedError();
          const replay = TransactionDtoSchema.safeParse(stored?.response);
          if (!replay.success)
            throw new ConflictError(
              "A request with this Idempotency-Key is still being processed",
            );
          return { transaction: replay.data, replayed: true };
        }

        const account = await manual.findAccountForWrite(
          userId,
          body.accountId,
          tx,
        );
        if (!account) throw new NotFoundError("account");
        if (!account.isManual || !MANUAL_SUBTYPES.has(account.subtype))
          throw new UnprocessableError(
            "Transactions can only be added to manual accounts",
          );
        if (account.archivedAt)
          throw new ConflictError("This account is archived");
        const categoryId = body.categoryId ?? null;
        if (
          categoryId !== null &&
          !(await repository.categoryExists(userId, categoryId, tx))
        )
          throw new ValidationError(
            "categoryId does not exist or is not accessible to this user.",
          );

        const amount = BigInt(body.amount);
        const inserted = await manual.insertManualTransaction(
          {
            userId,
            accountId: account.id,
            amount,
            currency: account.currency,
            date: body.date,
            name: body.name,
            merchantName: body.merchantName ?? null,
            categoryId,
          },
          tx,
        );

        // A category the user picked wins; rules only fill in when they didn't.
        if (categoryId === null) {
          const activeRules = (await rules.listActiveRules(userId, tx)).map(
            ruleForMatching,
          );
          const rule = matchRules(
            {
              merchantName: inserted.merchantName,
              name: inserted.name,
              amount: inserted.amount,
              accountId: inserted.accountId,
            },
            activeRules,
          );
          const patch = rulePatch(inserted, rule ?? undefined);
          if (Object.keys(patch).length > 0)
            await repository.applyRuleMatch(inserted.id, userId, patch, tx);
          if (rule?.actionAddTagIds && rule.actionAddTagIds.length > 0)
            await repository.addTransactionTags(
              inserted.id,
              userId,
              rule.actionAddTagIds,
              tx,
            );
        }

        const subtype = account.subtype as ManualAccountSubtype;
        const balance = await manual.adjustAccountBalance(
          userId,
          account.id,
          manualBalanceDeltaCents(subtype, amount),
          tx,
        );
        // Throws (rolling everything back) if a card would go below zero owed.
        normalizeManualBalanceCents(subtype, balance);

        const row = (await repository.findById(inserted.id, userId, tx))!;
        const tagsById = await repository.getTagIdsForTransactions(
          userId,
          [row.id],
          tx,
        );
        const transaction = toTransactionDto(row, tagsById.get(row.id) ?? []);
        await manual.completeIdempotencyKey(
          userId,
          idempotencyKey,
          row.id,
          transaction,
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityId: row.id,
            source: "transactions.manual_create",
            before: null,
            after: { ...row, balanceAfterCents: balance.toString() },
          },
          tx,
        );
        return { transaction, replayed: false };
      });
    },
    async exportTransactionsCsv(userId, filters) {
      const { rows, truncated } = await repository.listAllForExport(
        userId,
        filters,
      );
      const header =
        "Date,Name,Merchant,Account,Category,Tags,Amount,Currency,Status";
      const lines = rows.map((row) =>
        [
          row.date,
          csvEscape(row.name),
          csvEscape(row.merchantName ?? ""),
          csvEscape(row.accountName),
          csvEscape(row.categoryName ?? ""),
          csvEscape(row.tagNames ?? ""),
          (-Number(row.amount) / 100).toFixed(2),
          row.currency ?? "USD",
          row.reviewStatus ?? "",
        ].join(","),
      );
      return { csv: [header, ...lines].join("\n"), truncated };
    },
  };
}
