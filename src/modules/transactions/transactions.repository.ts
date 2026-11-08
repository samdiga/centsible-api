import { categoryVisibleTo } from "../categories/index.js";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { budgetSpendConditions } from "../../shared/budget-spend/budget-spend.js";
import {
  spendLineCategoryId,
  spendLinesMatching,
} from "../../shared/spend-lines/spend-lines.js";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import {
  ConflictError,
  ForbiddenError,
} from "../../platform/errors/app-error.js";
import { decodeCursor, encodeCursor } from "../../shared/pagination/cursor.js";
import type { SplitLine } from "./splits/split-math.js";
import {
  clearSplitsUnlessCategory,
  listSplitLines,
  rebalanceSplits,
  replaceSplitLines,
} from "./splits/splits.repository.js";

export type TransactionRow = typeof schema.transactions.$inferSelect;
export type TransactionListRow = Pick<
  TransactionRow,
  | "id"
  | "plaidTransactionId"
  | "accountId"
  | "amount"
  | "currency"
  | "date"
  | "status"
  | "name"
  | "merchantName"
  | "paymentChannel"
  | "plaidCategoryPrimary"
  | "plaidCategoryDetailed"
  | "categoryId"
  | "userCategoryOverride"
  | "isRecurring"
  | "reviewStatus"
  | "userName"
  | "notes"
  | "splitOutOfBalance"
> & {
  /** Only under a category, uncategorised or budget filter: the part in it. */
  filteredAmount?: bigint | null;
};
export type TransactionDb = Db | DbTransaction;
export type TransactionPatchFields = Readonly<{
  amount?: bigint | undefined;
  date?: string | undefined;
  name?: string | undefined;
  merchantName?: string | null | undefined;
  accountId?: string | undefined;
  userName?: string | null | undefined;
  notes?: string | null | undefined;
  categoryId?: string | null | undefined;
  householdMemberId?: string | null | undefined;
  reviewStatus?: "needs_review" | "reviewed" | "hidden" | undefined;
  excludeFromBudgets?: boolean | undefined;
  excludeFromReports?: boolean | undefined;
  tagIds?: string[] | undefined;
}>;
export type TransactionFilters = Readonly<{
  accountId?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  q?: string | undefined;
  hideHidden?: boolean | undefined;
  categoryIds?: readonly string[] | undefined;
  includeChildren?: boolean | undefined;
  uncategorized?: boolean | undefined;
  /** Budget usage's spend rules (see budgetSpendConditions). */
  budget?: boolean | undefined;
}>;
export type ExportFilters = Omit<TransactionFilters, "hideHidden">;
export type PlaidTransactionData = Readonly<{
  transaction_id: string;
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  pending: boolean;
  name: string;
  merchant_name?: string | null;
  payment_channel?: string | null;
  personal_finance_category?: {
    primary?: string | null;
    detailed?: string | null;
    confidence_level?: string | null;
  } | null;
  [key: string]: unknown;
}>;

export type TransactionRepository = Readonly<{
  upsertFromPlaid: (
    args: { userId: string; accountId: string; txn: PlaidTransactionData },
    db?: TransactionDb,
  ) => Promise<TransactionRow>;
  upsertManyFromPlaid: (
    rows: ReadonlyArray<{
      userId: string;
      accountId: string;
      txn: PlaidTransactionData;
    }>,
    db?: TransactionDb,
  ) => Promise<TransactionRow[]>;
  softDeleteByPlaidIds: (
    plaidTransactionIds: string[],
    userId: string,
    db?: TransactionDb,
  ) => Promise<void>;
  findByPlaidId: (
    plaidTransactionId: string,
    userId: string,
    db?: TransactionDb,
  ) => Promise<TransactionRow | null>;
  listByUser: (
    args: {
      userId: string;
      limit: number;
      cursor?: string | undefined;
      filters: TransactionFilters;
    },
    db?: TransactionDb,
  ) => Promise<{ rows: TransactionListRow[]; nextCursor: string | null }>;
  findById: (
    id: string,
    userId: string,
    db?: TransactionDb,
  ) => Promise<TransactionRow | null>;
  /** Locks a live, tenant-scoped transaction row for a financial mutation. */
  findByIdForUpdate: (
    id: string,
    userId: string,
    db: DbTransaction,
  ) => Promise<TransactionRow | null>;
  listSimilarByMerchant: (
    args: { userId: string; transactionId: string; limit: number },
    db?: TransactionDb,
  ) => Promise<TransactionListRow[] | null>;
  updateTransaction: (
    id: string,
    userId: string,
    patch: TransactionPatchFields,
    db?: TransactionDb,
  ) => Promise<TransactionRow | null>;
  /** Soft-deletes a live transaction; returns null if it was already removed. */
  softDeleteTransaction: (
    id: string,
    userId: string,
    db: DbTransaction,
  ) => Promise<TransactionRow | null>;
  applyRuleMatch: (
    id: string,
    userId: string,
    patch: TransactionPatchFields,
    db?: TransactionDb,
  ) => Promise<TransactionRow | null>;
  bulkUpdateTransactions: (
    ids: string[],
    userId: string,
    patch: TransactionPatchFields,
    db?: TransactionDb,
  ) => Promise<number>;
  listAllForExport: (
    userId: string,
    filters: ExportFilters,
    db?: TransactionDb,
  ) => Promise<{
    rows: Array<{
      id: string;
      date: string;
      name: string;
      merchantName: string | null;
      accountName: string;
      categoryName: string | null;
      /** A split's lines, "Restaurants $100.00; Owed to me $200.00" (T-186). */
      splitCategories: string | null;
      tagNames: string | null;
      amount: bigint;
      currency: string | null;
      reviewStatus: TransactionRow["reviewStatus"];
    }>;
    truncated: boolean;
  }>;
  categoryExists: (
    userId: string,
    categoryId: string,
    db?: TransactionDb,
  ) => Promise<boolean>;
  householdMemberExists: (
    userId: string,
    memberId: string,
    db?: TransactionDb,
  ) => Promise<boolean>;
  /** True when every id in `tagIds` exists and belongs to `userId`. Vacuously true for an empty array. */
  tagsExist: (
    userId: string,
    tagIds: string[],
    db?: TransactionDb,
  ) => Promise<boolean>;
  /** Batched so a list page costs one join query, not one per row. */
  getTagIdsForTransactions: (
    userId: string,
    transactionIds: string[],
    db?: TransactionDb,
  ) => Promise<Map<string, string[]>>;
  /** Full-replace: clears then (if non-empty) re-inserts the transaction's tag set. */
  replaceTransactionTags: (
    id: string,
    tagIds: string[],
    db?: TransactionDb,
  ) => Promise<void>;
  /** Full-replace applied identically to every transaction in `ids`. */
  replaceTransactionTagsForMany: (
    ids: string[],
    tagIds: string[],
    db?: TransactionDb,
  ) => Promise<void>;
  /** Additive: inserts new tag associations, leaves existing ones (including ones a user added by hand) untouched. Never a replace. */
  addTransactionTags: (
    id: string,
    userId: string,
    tagIds: string[],
    db?: TransactionDb,
  ) => Promise<void>;
  recordAudit: (
    audit: {
      userId: string;
      entityId: string;
      source: string;
      action?: "update" | "delete";
      before: unknown;
      after?: unknown;
    },
    db?: TransactionDb,
  ) => Promise<void>;
  /** Category lines of split transactions (T-186); see splits.repository.ts. */
  listSplitLines: (
    userId: string,
    transactionIds: readonly string[],
    db?: TransactionDb,
  ) => Promise<Map<string, SplitLine[]>>;
  replaceSplitLines: (
    userId: string,
    transactionId: string,
    lines: readonly SplitLine[],
    db?: TransactionDb,
  ) => Promise<void>;
  clearSplitsUnlessCategory: (
    userId: string,
    transactionIds: readonly string[],
    categoryId: string | null,
    db?: TransactionDb,
  ) => Promise<void>;
  rebalanceSplits: (
    userId: string,
    transactionIds: readonly string[],
    db?: TransactionDb,
  ) => Promise<void>;
}>;

function dollarsToCents(amount: number): bigint {
  if (!Number.isFinite(amount))
    throw new ConflictError("Plaid returned an invalid transaction amount");
  return BigInt(Math.round(amount * 100));
}

function plaidInsertRow({
  userId,
  accountId,
  txn,
}: {
  userId: string;
  accountId: string;
  txn: PlaidTransactionData;
}) {
  return {
    userId,
    accountId,
    plaidTransactionId: txn.transaction_id,
    amount: dollarsToCents(txn.amount),
    currency: txn.iso_currency_code ?? "USD",
    date: txn.date,
    authorizedDate: txn.authorized_date ?? null,
    status: txn.pending ? ("pending" as const) : ("posted" as const),
    name: txn.name,
    merchantName: txn.merchant_name ?? null,
    paymentChannel: txn.payment_channel ?? null,
    plaidCategoryPrimary: txn.personal_finance_category?.primary ?? null,
    plaidCategoryDetailed: txn.personal_finance_category?.detailed ?? null,
    plaidCategoryConfidence:
      txn.personal_finance_category?.confidence_level ?? null,
    plaidRawPayload: txn as Record<string, unknown>,
  };
}

/** Built lazily so modules that mock the database client can still import this file. */
const listColumns = () => ({
  id: schema.transactions.id,
  plaidTransactionId: schema.transactions.plaidTransactionId,
  accountId: schema.transactions.accountId,
  amount: schema.transactions.amount,
  currency: schema.transactions.currency,
  date: schema.transactions.date,
  status: schema.transactions.status,
  name: schema.transactions.name,
  merchantName: schema.transactions.merchantName,
  paymentChannel: schema.transactions.paymentChannel,
  plaidCategoryPrimary: schema.transactions.plaidCategoryPrimary,
  plaidCategoryDetailed: schema.transactions.plaidCategoryDetailed,
  categoryId: schema.transactions.categoryId,
  userCategoryOverride: schema.transactions.userCategoryOverride,
  isRecurring: schema.transactions.isRecurring,
  reviewStatus: schema.transactions.reviewStatus,
  userName: schema.transactions.userName,
  notes: schema.transactions.notes,
  splitOutOfBalance: schema.transactions.splitOutOfBalance,
});

/** Same key as `merchantKey` in auto-categorize.ts, as SQL. */
const merchantKeyExpr = () =>
  sql<string>`lower(coalesce(nullif(trim(${schema.transactions.merchantName}), ''), trim(${schema.transactions.name})))`;

/**
 * The category, uncategorised and budget filters, as conditions one counted
 * line of a transaction must meet together (T-186 splits; spend-lines.ts):
 * a split matches once, under each of its categories. Null when none apply.
 */
function lineFilterConditions(filters: TransactionFilters): SQL[] | null {
  const conditions: SQL[] = [];
  if (filters.categoryIds?.length)
    conditions.push(
      filters.includeChildren
        ? or(
            inArray(spendLineCategoryId(), [...filters.categoryIds]),
            inArray(schema.categories.parentId, [...filters.categoryIds]),
          )!
        : inArray(spendLineCategoryId(), [...filters.categoryIds]),
    );
  if (filters.uncategorized) conditions.push(isNull(spendLineCategoryId()));
  if (filters.budget) conditions.push(...budgetSpendConditions());
  return conditions.length > 0 ? conditions : null;
}

function conditionsFor(userId: string, filters: TransactionFilters) {
  const conditions = [
    eq(schema.transactions.userId, userId),
    isNull(schema.transactions.deletedAt),
    // A soft-deleted account (removed by the user, or left behind when a
    // duplicate Plaid Item is disconnected) keeps its transactions - by
    // design, so relinking restores history - but they must not appear in
    // the live feed while the account is gone, or a duplicate-item cleanup
    // (item soft-deleted -> its accounts soft-deleted, but their
    // transactions untouched) shows every real transaction twice.
    isNull(schema.accounts.deletedAt),
  ];
  if (filters.accountId)
    conditions.push(eq(schema.transactions.accountId, filters.accountId));
  if (filters.dateFrom)
    conditions.push(gte(schema.transactions.date, filters.dateFrom));
  if (filters.dateTo)
    conditions.push(lte(schema.transactions.date, filters.dateTo));
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    conditions.push(
      or(
        ilike(schema.transactions.name, pattern),
        ilike(schema.transactions.merchantName, pattern),
        ilike(schema.transactions.userName, pattern),
      )!,
    );
  }
  const lineMatch = lineFilterConditions(filters);
  if (lineMatch) conditions.push(spendLinesMatching(lineMatch).exists);
  // Budget usage counts hidden transactions, so its drill-in shows them.
  if (filters.hideHidden !== false && !filters.budget)
    conditions.push(ne(schema.transactions.reviewStatus, "hidden"));
  return conditions;
}

type PlaidInsertRow = ReturnType<typeof plaidInsertRow>;

const adoptionKey = (row: {
  accountId: string;
  date: string;
  amount: bigint;
  name: string;
}) => `${row.accountId}|${row.date}|${row.amount}|${row.name}`;

/**
 * After a relink takes over a removed account, the new Plaid item re-sends the
 * account's history under new transaction ids. Each incoming transaction with
 * an unseen id adopts one matching old row (same account, date, amount, name)
 * by taking over its plaid_transaction_id, so the upsert below updates that row
 * instead of inserting a duplicate — keeping history and user edits.
 *
 * Only rows whose stored payload came from a *different* Plaid account than
 * the account's current one can be adopted. That is true only for history
 * imported before a takeover, so ordinary syncs (two identical coffees on
 * different days) never steal each other's rows, and rows with no payload are
 * never touched.
 */
async function adoptRelinkedTransactions(
  chunk: PlaidInsertRow[],
  db: Db | DbTransaction,
): Promise<void> {
  const incomingIds = chunk.map((row) => row.plaidTransactionId);
  const known = new Set(
    (
      await db
        .select({ id: schema.transactions.plaidTransactionId })
        .from(schema.transactions)
        .where(inArray(schema.transactions.plaidTransactionId, incomingIds))
    ).map((row) => row.id),
  );
  const fresh = chunk.filter((row) => !known.has(row.plaidTransactionId));
  if (fresh.length === 0) return;

  const userIds = [...new Set(fresh.map((row) => row.userId))];
  const accountIds = [...new Set(fresh.map((row) => row.accountId))];
  const candidates = await db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      name: schema.transactions.name,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.transactions.accountId),
    )
    .where(
      and(
        inArray(schema.transactions.userId, userIds),
        inArray(schema.transactions.accountId, accountIds),
        isNull(schema.transactions.deletedAt),
        isNotNull(schema.transactions.plaidTransactionId),
        sql`${schema.transactions.plaidRawPayload}->>'account_id' is not null`,
        sql`${schema.transactions.plaidRawPayload}->>'account_id' <> ${schema.accounts.plaidAccountId}`,
      ),
    )
    .orderBy(asc(schema.transactions.date), asc(schema.transactions.id));
  if (candidates.length === 0) return;

  const pool = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = adoptionKey(candidate);
    pool.set(key, [...(pool.get(key) ?? []), candidate.id]);
  }
  for (const row of fresh) {
    const queue = pool.get(adoptionKey(row));
    const adoptedId = queue?.shift();
    if (!adoptedId) continue;
    await db
      .update(schema.transactions)
      .set({
        plaidTransactionId: row.plaidTransactionId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.transactions.id, adoptedId),
          eq(schema.transactions.userId, row.userId),
        ),
      );
  }
}

/**
 * When a charge posts, Plaid sends it as a new transaction whose
 * pending_transaction_id names the pending one it replaces. A category the
 * user picked, or a note they wrote, on the pending row carries over, so the
 * rules and auto-categorising that follow leave the posted row alone. Only
 * on the insert: later updates never bring back a note the user cleared. The
 * pending row may already be removed (Plaid's `removed` can arrive first).
 */
async function carryPendingChoices(
  saved: TransactionRow[],
  inserted: ReadonlySet<string>,
  db: TransactionDb,
): Promise<TransactionRow[]> {
  const pendingIdOf = (row: TransactionRow) => {
    const payload = row.plaidRawPayload as Record<string, unknown> | null;
    const id = payload?.["pending_transaction_id"];
    return typeof id === "string" && id ? id : null;
  };
  const posted = saved.filter(
    (row) =>
      inserted.has(row.id) &&
      pendingIdOf(row) !== null &&
      (!row.userCategoryOverride || row.notes === null),
  );
  if (posted.length === 0) return saved;
  const pendingRows = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        inArray(
          schema.transactions.plaidTransactionId,
          posted.map((row) => pendingIdOf(row)!),
        ),
        or(
          eq(schema.transactions.userCategoryOverride, true),
          isNotNull(schema.transactions.notes),
        ),
      ),
    );
  const pendingByKey = new Map(
    pendingRows.map((row) => [`${row.userId}:${row.plaidTransactionId}`, row]),
  );
  const carried = new Map<string, TransactionRow>();
  for (const row of posted) {
    const pending = pendingByKey.get(`${row.userId}:${pendingIdOf(row)}`);
    if (!pending || pending.id === row.id) continue;
    const patch: Partial<TransactionRow> = {};
    if (!row.userCategoryOverride && pending.userCategoryOverride) {
      patch.categoryId = pending.categoryId;
      patch.userCategoryOverride = true;
    }
    if (row.notes === null && pending.notes !== null)
      patch.notes = pending.notes;
    if (Object.keys(patch).length === 0) continue;
    const [updated] = await db
      .update(schema.transactions)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.id, row.id),
          eq(schema.transactions.userId, row.userId),
        ),
      )
      .returning();
    if (updated) carried.set(updated.id, updated);
  }
  return saved.map((row) => carried.get(row.id) ?? row);
}

export const transactionRepository: TransactionRepository = {
  async upsertManyFromPlaid(rows, db = getDb()) {
    if (rows.length === 0) return [];
    const output: TransactionRow[] = [];
    for (let index = 0; index < rows.length; index += 500) {
      const chunk = rows.slice(index, index + 500).map(plaidInsertRow);
      await adoptRelinkedTransactions(chunk, db);
      const updated = await db
        .insert(schema.transactions)
        .values(chunk)
        .onConflictDoUpdate({
          target: schema.transactions.plaidTransactionId,
          setWhere: sql`${schema.transactions.userId} = excluded.user_id`,
          set: {
            amount: sql`excluded.amount_cents`,
            currency: sql`excluded.currency`,
            date: sql`excluded.date`,
            authorizedDate: sql`excluded.authorized_date`,
            status: sql`excluded.status`,
            name: sql`excluded.name`,
            merchantName: sql`excluded.merchant_name`,
            paymentChannel: sql`excluded.payment_channel`,
            plaidRawPayload: sql`excluded.plaid_raw_payload`,
            updatedAt: new Date(),
            plaidCategoryPrimary: sql`CASE WHEN ${schema.transactions.userCategoryOverride} = true THEN ${schema.transactions.plaidCategoryPrimary} ELSE excluded.plaid_category_primary END`,
            plaidCategoryDetailed: sql`CASE WHEN ${schema.transactions.userCategoryOverride} = true THEN ${schema.transactions.plaidCategoryDetailed} ELSE excluded.plaid_category_detailed END`,
            plaidCategoryConfidence: sql`CASE WHEN ${schema.transactions.userCategoryOverride} = true THEN ${schema.transactions.plaidCategoryConfidence} ELSE excluded.plaid_category_confidence END`,
          },
        })
        .returning({
          ...getTableColumns(schema.transactions),
          // xmax is 0 only on a row this statement inserted (not updated).
          inserted: sql<boolean>`(xmax = 0)`,
        });
      const inserted = new Set(
        updated.filter((row) => row.inserted).map((row) => row.id),
      );
      const saved = updated.map((row) => {
        const { inserted: _, ...columns } = row;
        void _;
        return columns;
      });
      output.push(...(await carryPendingChoices(saved, inserted, db)));
    }
    return output;
  },
  async upsertFromPlaid(args, db = getDb()) {
    const row = (await this.upsertManyFromPlaid([args], db))[0];
    if (!row)
      throw new ConflictError("Plaid transaction belongs to another user");
    return row;
  },
  async softDeleteByPlaidIds(plaidTransactionIds, userId, db = getDb()) {
    if (plaidTransactionIds.length === 0) return;
    await db
      .update(schema.transactions)
      .set({ deletedAt: new Date(), status: "removed", updatedAt: new Date() })
      .where(
        and(
          inArray(schema.transactions.plaidTransactionId, plaidTransactionIds),
          eq(schema.transactions.userId, userId),
        ),
      );
  },
  async findByPlaidId(plaidTransactionId, userId, db = getDb()) {
    return (
      (
        await db
          .select()
          .from(schema.transactions)
          .where(
            and(
              eq(schema.transactions.plaidTransactionId, plaidTransactionId),
              eq(schema.transactions.userId, userId),
            ),
          )
          .limit(1)
      )[0] ?? null
    );
  },
  async listByUser({ userId, limit, cursor, filters }, db = getDb()) {
    const conditions = conditionsFor(userId, filters);
    if (cursor) {
      const { date, id } = decodeCursor(cursor);
      conditions.push(
        or(
          lt(schema.transactions.date, date),
          and(
            eq(schema.transactions.date, date),
            lt(schema.transactions.id, id),
          )!,
        )!,
      );
    }
    // Under a category, uncategorised or budget filter each row also carries
    // the part of its amount in the filter (a split's matching lines).
    const lineMatch = lineFilterConditions(filters);
    const rows = await db
      .select({
        ...listColumns(),
        ...(lineMatch
          ? {
              filteredAmount: sql<
                bigint | null
              >`${spendLinesMatching(lineMatch).amount}`.mapWith(
                (value: string | null) =>
                  value === null ? null : BigInt(value),
              ),
            }
          : {}),
      })
      .from(schema.transactions)
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.transactions.accountId),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.transactions.date), desc(schema.transactions.id))
      .limit(limit + 1);
    const next = rows.length > limit ? rows.pop() : undefined;
    const last = rows[rows.length - 1];
    return {
      rows,
      nextCursor:
        next && last ? encodeCursor({ date: last.date, id: last.id }) : null,
    };
  },
  async findById(id, userId, db = getDb()) {
    return (
      (
        await db
          .select()
          .from(schema.transactions)
          .where(
            and(
              eq(schema.transactions.id, id),
              eq(schema.transactions.userId, userId),
              isNull(schema.transactions.deletedAt),
            ),
          )
          .limit(1)
      )[0] ?? null
    );
  },
  async findByIdForUpdate(id, userId, db) {
    return (
      (
        await db
          .select()
          .from(schema.transactions)
          .where(
            and(
              eq(schema.transactions.id, id),
              eq(schema.transactions.userId, userId),
              isNull(schema.transactions.deletedAt),
            ),
          )
          .for("update")
          .limit(1)
      )[0] ?? null
    );
  },
  async listSimilarByMerchant({ userId, transactionId, limit }, db = getDb()) {
    const edited = (
      await db
        .select({
          categoryId: schema.transactions.categoryId,
          key: merchantKeyExpr(),
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.id, transactionId),
            eq(schema.transactions.userId, userId),
            isNull(schema.transactions.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!edited) return null;
    return db
      .select(listColumns())
      .from(schema.transactions)
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.transactions.accountId),
      )
      .where(
        and(
          ...conditionsFor(userId, {}),
          ne(schema.transactions.id, transactionId),
          eq(merchantKeyExpr(), edited.key),
          sql`${schema.transactions.categoryId} IS DISTINCT FROM ${edited.categoryId}`,
          // A split is the user's own division; one category never replaces
          // it from here (T-186).
          sql`NOT EXISTS (
            SELECT 1 FROM ${schema.transactionCategorySplits}
            WHERE ${schema.transactionCategorySplits.transactionId} = ${schema.transactions.id}
          )`,
        ),
      )
      .orderBy(desc(schema.transactions.date), desc(schema.transactions.id))
      .limit(limit);
  },
  async updateTransaction(id, userId, patch, db = getDb()) {
    const { tagIds, ...columnPatch } = patch;
    void tagIds; // excluded from the column update — transaction_tags is a join table, not a column
    return (
      (
        await db
          .update(schema.transactions)
          .set({
            ...columnPatch,
            updatedAt: new Date(),
            ...("categoryId" in columnPatch
              ? { userCategoryOverride: true }
              : {}),
          })
          .where(
            and(
              eq(schema.transactions.id, id),
              eq(schema.transactions.userId, userId),
              isNull(schema.transactions.deletedAt),
            ),
          )
          .returning()
      )[0] ?? null
    );
  },
  async softDeleteTransaction(id, userId, db) {
    const now = new Date();
    return (
      (
        await db
          .update(schema.transactions)
          .set({ deletedAt: now, status: "removed", updatedAt: now })
          .where(
            and(
              eq(schema.transactions.id, id),
              eq(schema.transactions.userId, userId),
              isNull(schema.transactions.deletedAt),
            ),
          )
          .returning()
      )[0] ?? null
    );
  },
  async applyRuleMatch(id, userId, patch, db = getDb()) {
    const { tagIds, ...columnPatch } = patch;
    void tagIds; // tags are a join table, not a column — see addTransactionTags
    const rows = await db
      .update(schema.transactions)
      .set({ ...columnPatch, updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.userId, userId),
          isNull(schema.transactions.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async bulkUpdateTransactions(ids, userId, patch, db = getDb()) {
    if (ids.length === 0) return 0;
    const owned = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          inArray(schema.transactions.id, ids),
          eq(schema.transactions.userId, userId),
          isNull(schema.transactions.deletedAt),
        ),
      );
    if (owned.length !== ids.length)
      throw new ForbiddenError("One or more transactions not found");
    const { tagIds, ...columnPatch } = patch;
    void tagIds; // excluded from the column update — transaction_tags is a join table, not a column
    return (
      await db
        .update(schema.transactions)
        .set({
          ...columnPatch,
          updatedAt: new Date(),
          ...("categoryId" in columnPatch
            ? { userCategoryOverride: true }
            : {}),
        })
        .where(
          and(
            inArray(schema.transactions.id, ids),
            eq(schema.transactions.userId, userId),
            isNull(schema.transactions.deletedAt),
          ),
        )
        .returning()
    ).length;
  },
  async listAllForExport(userId, filters, db = getDb()) {
    const rows = await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        name: schema.transactions.name,
        merchantName: schema.transactions.merchantName,
        accountName: schema.accounts.name,
        categoryName: schema.categories.name,
        // A split's lines in one cell, amounts from integer cents as
        // unsigned dollars, so the export keeps one row per transaction.
        splitCategories: sql<string | null>`(
          select string_agg(
            coalesce(line_category.name, 'Uncategorized') || ' $' ||
              to_char(abs(${schema.transactionCategorySplits.amount})::numeric / 100, 'FM999999999990.00'),
            '; ' order by ${schema.transactionCategorySplits.position}
          )
          from ${schema.transactionCategorySplits}
          left join ${schema.categories} as line_category
            on line_category.id = ${schema.transactionCategorySplits.categoryId}
          where ${schema.transactionCategorySplits.transactionId} = ${schema.transactions.id}
        )`,
        // A correlated subquery, not a join, so a transaction with N tags
        // doesn't multiply into N export rows the way a LEFT JOIN to
        // transaction_tags would.
        tagNames: sql<string | null>`(
          select string_agg(${schema.tags.name}, ',')
          from ${schema.transactionTags}
          inner join ${schema.tags} on ${schema.tags.id} = ${schema.transactionTags.tagId}
          where ${schema.transactionTags.transactionId} = ${schema.transactions.id}
        )`,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        reviewStatus: schema.transactions.reviewStatus,
      })
      .from(schema.transactions)
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.transactions.accountId),
      )
      .leftJoin(
        schema.categories,
        eq(schema.categories.id, schema.transactions.categoryId),
      )
      .where(and(...conditionsFor(userId, filters)))
      .orderBy(desc(schema.transactions.date))
      .limit(10_001);
    return { rows: rows.slice(0, 10_000), truncated: rows.length > 10_000 };
  },
  async categoryExists(userId, categoryId, db = getDb()) {
    return (
      (
        await db
          .select({ id: schema.categories.id })
          .from(schema.categories)
          .where(
            and(
              eq(schema.categories.id, categoryId),
              isNull(schema.categories.archivedAt),
              categoryVisibleTo(userId),
            ),
          )
          .limit(1)
      ).length > 0
    );
  },
  async householdMemberExists(userId, memberId, db = getDb()) {
    return (
      (
        await db
          .select({ id: schema.householdMembers.id })
          .from(schema.householdMembers)
          .where(
            and(
              eq(schema.householdMembers.id, memberId),
              eq(schema.householdMembers.userId, userId),
            ),
          )
          .limit(1)
      ).length > 0
    );
  },
  async tagsExist(userId, tagIds, db = getDb()) {
    if (tagIds.length === 0) return true;
    const unique = [...new Set(tagIds)];
    const rows = await db
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(
        and(inArray(schema.tags.id, unique), eq(schema.tags.userId, userId)),
      );
    return rows.length === unique.length;
  },
  async getTagIdsForTransactions(userId, transactionIds, db = getDb()) {
    const map = new Map<string, string[]>();
    if (transactionIds.length === 0) return map;
    const rows = await db
      .select({
        transactionId: schema.transactionTags.transactionId,
        tagId: schema.transactionTags.tagId,
      })
      .from(schema.transactionTags)
      .innerJoin(
        schema.transactions,
        eq(schema.transactions.id, schema.transactionTags.transactionId),
      )
      .where(
        and(
          inArray(schema.transactionTags.transactionId, transactionIds),
          eq(schema.transactions.userId, userId),
        ),
      );
    for (const row of rows) {
      const list = map.get(row.transactionId) ?? [];
      list.push(row.tagId);
      map.set(row.transactionId, list);
    }
    return map;
  },
  async replaceTransactionTags(id, tagIds, db = getDb()) {
    await db
      .delete(schema.transactionTags)
      .where(eq(schema.transactionTags.transactionId, id));
    if (tagIds.length === 0) return;
    const unique = [...new Set(tagIds)];
    await db
      .insert(schema.transactionTags)
      .values(unique.map((tagId) => ({ transactionId: id, tagId })));
  },
  async replaceTransactionTagsForMany(ids, tagIds, db = getDb()) {
    if (ids.length === 0) return;
    await db
      .delete(schema.transactionTags)
      .where(inArray(schema.transactionTags.transactionId, ids));
    if (tagIds.length === 0) return;
    const unique = [...new Set(tagIds)];
    await db
      .insert(schema.transactionTags)
      .values(
        ids.flatMap((transactionId) =>
          unique.map((tagId) => ({ transactionId, tagId })),
        ),
      );
  },
  async addTransactionTags(id, userId, tagIds, db = getDb()) {
    if (tagIds.length === 0) return;
    const unique = [...new Set(tagIds)];
    const existing = await db
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(
        and(inArray(schema.tags.id, unique), eq(schema.tags.userId, userId)),
      );
    const validIds = existing.map((row) => row.id);
    if (validIds.length === 0) return;
    await db
      .insert(schema.transactionTags)
      .values(validIds.map((tagId) => ({ transactionId: id, tagId })))
      .onConflictDoNothing();
  },
  listSplitLines: (userId, ids, db = getDb()) =>
    listSplitLines(userId, ids, db),
  replaceSplitLines: (userId, id, lines, db = getDb()) =>
    replaceSplitLines(userId, id, lines, db),
  clearSplitsUnlessCategory: (userId, ids, categoryId, db = getDb()) =>
    clearSplitsUnlessCategory(userId, ids, categoryId, db),
  rebalanceSplits: (userId, ids, db = getDb()) =>
    rebalanceSplits(userId, ids, db),
  async recordAudit(audit, db = getDb()) {
    await auditLogRepository.record(
      {
        userId: audit.userId,
        entityType: "transaction",
        entityId: audit.entityId,
        action: audit.action ?? "update",
        source: audit.source,
        before: audit.before,
        after: audit.after,
      },
      db,
    );
  },
};

/** Binds repository operations to an explicitly supplied database for isolated tests and adapters. */
export function createTransactionRepository(db: Db): TransactionRepository {
  return {
    upsertFromPlaid: (args, tx) =>
      transactionRepository.upsertFromPlaid(args, tx ?? db),
    upsertManyFromPlaid: (rows, tx) =>
      transactionRepository.upsertManyFromPlaid(rows, tx ?? db),
    softDeleteByPlaidIds: (ids, userId, tx) =>
      transactionRepository.softDeleteByPlaidIds(ids, userId, tx ?? db),
    findByPlaidId: (id, userId, tx) =>
      transactionRepository.findByPlaidId(id, userId, tx ?? db),
    listByUser: (args, tx) => transactionRepository.listByUser(args, tx ?? db),
    findById: (id, userId, tx) =>
      transactionRepository.findById(id, userId, tx ?? db),
    findByIdForUpdate: (id, userId, tx) =>
      transactionRepository.findByIdForUpdate(id, userId, tx),
    listSimilarByMerchant: (args, tx) =>
      transactionRepository.listSimilarByMerchant(args, tx ?? db),
    updateTransaction: (id, userId, patch, tx) =>
      transactionRepository.updateTransaction(id, userId, patch, tx ?? db),
    softDeleteTransaction: (id, userId, tx) =>
      transactionRepository.softDeleteTransaction(id, userId, tx),
    applyRuleMatch: (id, userId, patch, tx) =>
      transactionRepository.applyRuleMatch(id, userId, patch, tx ?? db),
    bulkUpdateTransactions: (ids, userId, patch, tx) =>
      transactionRepository.bulkUpdateTransactions(
        ids,
        userId,
        patch,
        tx ?? db,
      ),
    listAllForExport: (userId, filters, tx) =>
      transactionRepository.listAllForExport(userId, filters, tx ?? db),
    categoryExists: (userId, id, tx) =>
      transactionRepository.categoryExists(userId, id, tx ?? db),
    householdMemberExists: (userId, id, tx) =>
      transactionRepository.householdMemberExists(userId, id, tx ?? db),
    tagsExist: (userId, ids, tx) =>
      transactionRepository.tagsExist(userId, ids, tx ?? db),
    getTagIdsForTransactions: (userId, ids, tx) =>
      transactionRepository.getTagIdsForTransactions(userId, ids, tx ?? db),
    replaceTransactionTags: (id, tagIds, tx) =>
      transactionRepository.replaceTransactionTags(id, tagIds, tx ?? db),
    replaceTransactionTagsForMany: (ids, tagIds, tx) =>
      transactionRepository.replaceTransactionTagsForMany(
        ids,
        tagIds,
        tx ?? db,
      ),
    addTransactionTags: (id, userId, tagIds, tx) =>
      transactionRepository.addTransactionTags(id, userId, tagIds, tx ?? db),
    recordAudit: (audit, tx) =>
      transactionRepository.recordAudit(audit, tx ?? db),
    listSplitLines: (userId, ids, tx) =>
      transactionRepository.listSplitLines(userId, ids, tx ?? db),
    replaceSplitLines: (userId, id, lines, tx) =>
      transactionRepository.replaceSplitLines(userId, id, lines, tx ?? db),
    clearSplitsUnlessCategory: (userId, ids, categoryId, tx) =>
      transactionRepository.clearSplitsUnlessCategory(
        userId,
        ids,
        categoryId,
        tx ?? db,
      ),
    rebalanceSplits: (userId, ids, tx) =>
      transactionRepository.rebalanceSplits(userId, ids, tx ?? db),
  };
}

export type PlaidTransactionWriter = Pick<
  TransactionRepository,
  | "upsertFromPlaid"
  | "upsertManyFromPlaid"
  | "softDeleteByPlaidIds"
  | "applyRuleMatch"
  | "addTransactionTags"
  | "rebalanceSplits"
>;
export function createPlaidTransactionWriter(db: Db): PlaidTransactionWriter {
  const repository = createTransactionRepository(db);
  return {
    upsertFromPlaid: repository.upsertFromPlaid,
    upsertManyFromPlaid: repository.upsertManyFromPlaid,
    softDeleteByPlaidIds: repository.softDeleteByPlaidIds,
    applyRuleMatch: repository.applyRuleMatch,
    addTransactionTags: repository.addTransactionTags,
    rebalanceSplits: repository.rebalanceSplits,
  };
}
