import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import {
  ConflictError,
  ForbiddenError,
} from "../../platform/errors/app-error.js";
import { decodeCursor, encodeCursor } from "../../shared/pagination/cursor.js";

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
>;
export type TransactionDb = Db | DbTransaction;
export type TransactionPatchFields = Readonly<{
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
  updateTransaction: (
    id: string,
    userId: string,
    patch: TransactionPatchFields,
    db?: TransactionDb,
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
    rows: Array<
      Pick<
        TransactionRow,
        | "id"
        | "date"
        | "name"
        | "merchantName"
        | "accountId"
        | "categoryId"
        | "amount"
        | "currency"
        | "reviewStatus"
      >
    >;
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
    tagIds: string[],
    db?: TransactionDb,
  ) => Promise<void>;
  recordAudit: (
    audit: {
      userId: string;
      entityId: string;
      source: string;
      before: unknown;
      after?: unknown;
    },
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

function conditionsFor(userId: string, filters: TransactionFilters) {
  const conditions = [
    eq(schema.transactions.userId, userId),
    isNull(schema.transactions.deletedAt),
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
  if (filters.hideHidden !== false)
    conditions.push(ne(schema.transactions.reviewStatus, "hidden"));
  return conditions;
}

export const transactionRepository: TransactionRepository = {
  async upsertManyFromPlaid(rows, db = getDb()) {
    if (rows.length === 0) return [];
    const output: TransactionRow[] = [];
    for (let index = 0; index < rows.length; index += 500) {
      const chunk = rows.slice(index, index + 500).map(plaidInsertRow);
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
        .returning();
      output.push(...updated);
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
    const rows = await db
      .select({
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
      })
      .from(schema.transactions)
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
            ...("categoryId" in columnPatch ? { userCategoryOverride: true } : {}),
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
          ...("categoryId" in columnPatch ? { userCategoryOverride: true } : {}),
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
        accountId: schema.transactions.accountId,
        categoryId: schema.transactions.categoryId,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        reviewStatus: schema.transactions.reviewStatus,
      })
      .from(schema.transactions)
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
              or(
                isNull(schema.categories.userId),
                eq(schema.categories.userId, userId),
              ),
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
      .where(and(inArray(schema.tags.id, unique), eq(schema.tags.userId, userId)));
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
    await db.delete(schema.transactionTags).where(eq(schema.transactionTags.transactionId, id));
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
    await db.insert(schema.transactionTags).values(
      ids.flatMap((transactionId) => unique.map((tagId) => ({ transactionId, tagId }))),
    );
  },
  async addTransactionTags(id, tagIds, db = getDb()) {
    if (tagIds.length === 0) return;
    const unique = [...new Set(tagIds)];
    await db
      .insert(schema.transactionTags)
      .values(unique.map((tagId) => ({ transactionId: id, tagId })))
      .onConflictDoNothing();
  },
  async recordAudit(audit, db = getDb()) {
    await auditLogRepository.record(
      {
        userId: audit.userId,
        entityType: "transaction",
        entityId: audit.entityId,
        action: "update",
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
    updateTransaction: (id, userId, patch, tx) =>
      transactionRepository.updateTransaction(id, userId, patch, tx ?? db),
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
    tagsExist: (userId, ids, tx) => transactionRepository.tagsExist(userId, ids, tx ?? db),
    getTagIdsForTransactions: (userId, ids, tx) =>
      transactionRepository.getTagIdsForTransactions(userId, ids, tx ?? db),
    replaceTransactionTags: (id, tagIds, tx) =>
      transactionRepository.replaceTransactionTags(id, tagIds, tx ?? db),
    replaceTransactionTagsForMany: (ids, tagIds, tx) =>
      transactionRepository.replaceTransactionTagsForMany(ids, tagIds, tx ?? db),
    addTransactionTags: (id, tagIds, tx) =>
      transactionRepository.addTransactionTags(id, tagIds, tx ?? db),
    recordAudit: (audit, tx) =>
      transactionRepository.recordAudit(audit, tx ?? db),
  };
}

export type PlaidTransactionWriter = Pick<
  TransactionRepository,
  | "upsertFromPlaid"
  | "upsertManyFromPlaid"
  | "softDeleteByPlaidIds"
  | "applyRuleMatch"
  | "addTransactionTags"
>;
export function createPlaidTransactionWriter(db: Db): PlaidTransactionWriter {
  const repository = createTransactionRepository(db);
  return {
    upsertFromPlaid: repository.upsertFromPlaid,
    upsertManyFromPlaid: repository.upsertManyFromPlaid,
    softDeleteByPlaidIds: repository.softDeleteByPlaidIds,
    applyRuleMatch: repository.applyRuleMatch,
    addTransactionTags: repository.addTransactionTags,
  };
}
