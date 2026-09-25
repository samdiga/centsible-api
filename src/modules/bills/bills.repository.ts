import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import type {
  NewRecurringSeries,
  RecurringSeriesUpdate,
} from "./recurring-engine.js";

export type BillRow = typeof schema.billSetup.$inferSelect;
type BillDb = Db | DbTransaction;
type BillPatch = {
  status?: BillRow["status"] | undefined;
  userConfirmed?: boolean | undefined;
  categoryId?: string | null | undefined;
  accountId?: string | null | undefined;
  notes?: string | null | undefined;
  billType?: "payable" | "transfer" | undefined;
  toAccountId?: string | null | undefined;
};
export type BillsRepository = Readonly<{
  list: (
    userId: string,
    statuses?: BillRow["status"][],
    db?: BillDb,
  ) => Promise<BillRow[]>;
  findById: (
    userId: string,
    id: string,
    db?: BillDb,
  ) => Promise<BillRow | null>;
  insertManual: (
    userId: string,
    input: {
      canonicalName: string;
      cadence: BillRow["cadence"];
      avgAmount: bigint;
      nextExpectedDate: string;
      categoryId: string | null;
      accountId: string | null;
      isIncome: boolean;
      notes: string | null;
      billType: "payable" | "transfer";
      toAccountId: string | null;
    },
    db?: BillDb,
  ) => Promise<BillRow>;
  update: (
    userId: string,
    id: string,
    patch: BillPatch,
    db?: BillDb,
  ) => Promise<BillRow | null>;
  softDelete: (userId: string, id: string, db?: BillDb) => Promise<boolean>;
  upsertDetected: (
    userId: string,
    series: NewRecurringSeries[],
    db?: BillDb,
  ) => Promise<void>;
  updateDetection: (
    userId: string,
    updates: RecurringSeriesUpdate[],
    db?: BillDb,
  ) => Promise<void>;
  upsertForecastEvents: (
    rows: Array<{
      userId: string;
      accountId: string | null;
      name: string;
      amountCents: bigint;
      date: string;
      categoryId: string | null;
      recurringSeriesId: string;
    }>,
    db?: BillDb,
  ) => Promise<void>;
  upsertBillForecastEvents: (
    rows: Array<{
      userId: string;
      accountId: string | null;
      name: string;
      amountCents: bigint;
      date: string;
      categoryId: string | null;
      recurringSeriesId: string;
      billOccurrenceId: string;
    }>,
    db?: BillDb,
  ) => Promise<void>;
  cancelFutureForecastEvents: (
    userId: string,
    billSetupId: string,
    db?: BillDb,
  ) => Promise<void>;
  detectionTransactions: (
    userId: string,
    db?: BillDb,
  ) => Promise<
    Array<{
      merchantName: string | null;
      name: string;
      amountCents: bigint;
      date: string;
      isIncome: boolean;
      isTransfer: boolean;
      excludeFromBudgets: boolean;
    }>
  >;
  listRecentRecurringTransactions: (
    userId: string,
    db?: BillDb,
  ) => Promise<
    Array<{
      id: string;
      recurringSeriesId: string | null;
      date: string;
      amount: bigint;
    }>
  >;
  listAutoConfirmationTransactions: (
    userId: string,
    dateFrom: string,
    dateTo: string,
    db?: BillDb,
  ) => Promise<
    Array<{ id: string; accountId: string; date: string; amount: bigint }>
  >;
  listOpenForecastEvents: (
    userId: string,
    billSetupIds: string[],
    db?: BillDb,
  ) => Promise<(typeof schema.forecastEvents.$inferSelect)[]>;
  resolveForecastEvent: (
    userId: string,
    forecastEventId: string,
    transactionId: string,
    db?: BillDb,
  ) => Promise<void>;
  resolveBillForecastEvent: (
    userId: string,
    billOccurrenceId: string,
    transactionId: string,
    db?: BillDb,
  ) => Promise<void>;
  accountExists: (userId: string, id: string, db?: BillDb) => Promise<boolean>;
  categoryExists: (userId: string, id: string, db?: BillDb) => Promise<boolean>;
  recordAudit: (
    audit: {
      userId: string;
      entityType: "bill_setup" | "bill_occurrence";
      entityId: string;
      action: "create" | "update" | "delete";
      source: string;
      before?: unknown;
      after?: unknown;
    },
    db?: BillDb,
  ) => Promise<void>;
}>;
const serialize = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
/** Last calendar day of a `YYYY-MM` month as `YYYY-MM-DD`. */
export const monthEnd = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return `${year}-${String(monthNumber).padStart(2, "0")}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, "0")}`;
};

export const billsRepository: BillsRepository = {
  async list(
    userId,
    statuses = ["active", "pending_confirmation"],
    db = getDb(),
  ) {
    return db
      .select()
      .from(schema.billSetup)
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          isNull(schema.billSetup.deletedAt),
          inArray(schema.billSetup.status, statuses),
        ),
      )
      .orderBy(schema.billSetup.nextExpectedDate);
  },
  async findById(userId, id, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.billSetup)
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          eq(schema.billSetup.id, id),
          isNull(schema.billSetup.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async insertManual(userId, input, db = getDb()) {
    const rows = await db
      .insert(schema.billSetup)
      .values({
        userId,
        ...input,
        status: "active",
        userConfirmed: true,
        autoDetected: false,
        merchantPatterns: [],
      })
      .returning();
    if (!rows[0]) throw new Error("Bill insert did not return a row");
    return rows[0];
  },
  async update(userId, id, patch, db = getDb()) {
    const rows = await db
      .update(schema.billSetup)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          eq(schema.billSetup.id, id),
          isNull(schema.billSetup.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async softDelete(userId, id, db = getDb()) {
    const rows = await db
      .update(schema.billSetup)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.billSetup.userId, userId),
          eq(schema.billSetup.id, id),
          isNull(schema.billSetup.deletedAt),
        ),
      )
      .returning({ id: schema.billSetup.id });
    return rows.length === 1;
  },
  async upsertDetected(userId, series, db = getDb()) {
    if (!series.length) return;
    await db
      .insert(schema.billSetup)
      .values(
        series.map((row) => ({
          userId,
          canonicalName: row.canonicalName,
          cadence: row.cadence,
          avgAmount: row.avgAmountCents,
          stdDevAmount: row.stdDevAmountCents,
          lastAmount: row.lastAmountCents,
          lastOccurredOn: row.lastOccurredOn,
          nextExpectedDate: row.nextExpectedDate,
          confidence: row.confidence,
          sampleCount: row.sampleCount,
          status: row.status,
          isIncome: row.isIncome,
          userConfirmed: false,
          autoDetected: true,
          merchantPatterns: [],
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.billSetup.userId,
          schema.billSetup.canonicalName,
          schema.billSetup.cadence,
        ],
      });
  },
  async updateDetection(userId, updates, db = getDb()) {
    for (const update of updates)
      await db
        .update(schema.billSetup)
        .set({
          lastOccurredOn: update.lastOccurredOn,
          nextExpectedDate: update.nextExpectedDate,
          lastAmount: update.lastAmountCents,
          avgAmount: update.avgAmountCents,
          sampleCount: update.sampleCount,
          ...(update.lastPriceChangeAt
            ? { lastPriceChangeAt: update.lastPriceChangeAt }
            : {}),
          ...(update.previousAvgAmountCents
            ? { previousAvgAmount: update.previousAvgAmountCents }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.billSetup.id, update.id),
            eq(schema.billSetup.userId, userId),
          ),
        );
  },
  async upsertForecastEvents(rows, db = getDb()) {
    if (!rows.length) return;
    await db
      .insert(schema.forecastEvents)
      .values(
        rows.map((row) => ({
          userId: row.userId,
          accountId: row.accountId,
          name: row.name,
          amount: row.amountCents,
          date: row.date,
          categoryId: row.categoryId,
          recurringSeriesId: row.recurringSeriesId,
          sourceType: "recurring" as const,
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.forecastEvents.userId,
          schema.forecastEvents.recurringSeriesId,
          schema.forecastEvents.date,
        ],
        where: sql`bill_occurrence_id IS NULL`,
      });
  },
  async upsertBillForecastEvents(rows, db = getDb()) {
    if (!rows.length) return;
    await db
      .insert(schema.forecastEvents)
      .values(
        rows.map((row) => ({
          userId: row.userId,
          accountId: row.accountId,
          name: row.name,
          amount: row.amountCents,
          date: row.date,
          categoryId: row.categoryId,
          recurringSeriesId: row.recurringSeriesId,
          billOccurrenceId: row.billOccurrenceId,
          sourceType: "recurring" as const,
        })),
      )
      .onConflictDoUpdate({
        target: schema.forecastEvents.billOccurrenceId,
        targetWhere: sql`bill_occurrence_id IS NOT NULL`,
        set: {
          accountId: sql`excluded.account_id`,
          name: sql`excluded.name`,
          amount: sql`excluded.amount_cents`,
          date: sql`excluded.date`,
          categoryId: sql`excluded.category_id`,
          updatedAt: new Date(),
        },
        setWhere: sql`${schema.forecastEvents.userId} = excluded.user_id AND ${schema.forecastEvents.resolvedToTransactionId} IS NULL AND ${schema.forecastEvents.deletedAt} IS NULL`,
      });
  },
  async cancelFutureForecastEvents(userId, billSetupId, db = getDb()) {
    await db
      .update(schema.forecastEvents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          eq(schema.forecastEvents.recurringSeriesId, billSetupId),
          isNull(schema.forecastEvents.deletedAt),
        ),
      );
  },
  async detectionTransactions(userId, db = getDb()) {
    return (
      await db
        .select({
          merchantName: schema.transactions.merchantName,
          name: schema.transactions.name,
          amountCents: schema.transactions.amount,
          date: schema.transactions.date,
          isIncome: schema.categories.isIncome,
          isTransfer: schema.categories.isTransfer,
          excludeFromBudgets: schema.transactions.excludeFromBudgets,
        })
        .from(schema.transactions)
        .leftJoin(
          schema.categories,
          eq(schema.transactions.categoryId, schema.categories.id),
        )
        .where(
          and(
            eq(schema.transactions.userId, userId),
            isNull(schema.transactions.deletedAt),
            sql`${schema.transactions.date} >= CURRENT_DATE - INTERVAL '90 days'`,
            eq(schema.transactions.status, "posted"),
          ),
        )
    ).map((row) => ({
      ...row,
      isIncome: row.isIncome ?? false,
      isTransfer: row.isTransfer ?? false,
    }));
  },
  async listRecentRecurringTransactions(userId, db = getDb()) {
    return db
      .select({
        id: schema.transactions.id,
        recurringSeriesId: schema.transactions.recurringSeriesId,
        date: schema.transactions.date,
        amount: schema.transactions.amount,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.status, "posted"),
          isNull(schema.transactions.deletedAt),
          sql`${schema.transactions.date} >= CURRENT_DATE - INTERVAL '21 days'`,
          not(isNull(schema.transactions.recurringSeriesId)),
        ),
      );
  },
  async listAutoConfirmationTransactions(
    userId,
    dateFrom,
    dateTo,
    db = getDb(),
  ) {
    return db
      .select({
        id: schema.transactions.id,
        accountId: schema.transactions.accountId,
        date: schema.transactions.date,
        amount: schema.transactions.amount,
      })
      .from(schema.transactions)
      .innerJoin(
        schema.accounts,
        and(
          eq(schema.accounts.id, schema.transactions.accountId),
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
          eq(schema.accounts.type, "depository"),
          inArray(schema.accounts.subtype, ["checking", "savings"]),
        ),
      )
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.status, "posted"),
          isNull(schema.transactions.deletedAt),
          sql`${schema.transactions.amount} > 0`,
          sql`${schema.transactions.date} >= ${dateFrom}`,
          sql`${schema.transactions.date} <= ${dateTo}`,
        ),
      );
  },
  async listOpenForecastEvents(userId, billSetupIds, db = getDb()) {
    if (!billSetupIds.length) return [];
    return db
      .select()
      .from(schema.forecastEvents)
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          inArray(schema.forecastEvents.recurringSeriesId, billSetupIds),
          isNull(schema.forecastEvents.resolvedToTransactionId),
          isNull(schema.forecastEvents.deletedAt),
          isNull(schema.forecastEvents.billOccurrenceId),
          sql`${schema.forecastEvents.date} >= CURRENT_DATE - INTERVAL '14 days'`,
          sql`${schema.forecastEvents.date} <= CURRENT_DATE + INTERVAL '7 days'`,
        ),
      );
  },
  async resolveForecastEvent(
    userId,
    forecastEventId,
    transactionId,
    db = getDb(),
  ) {
    await db
      .update(schema.forecastEvents)
      .set({ resolvedToTransactionId: transactionId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          eq(schema.forecastEvents.id, forecastEventId),
          isNull(schema.forecastEvents.deletedAt),
        ),
      );
  },
  async resolveBillForecastEvent(
    userId,
    billOccurrenceId,
    transactionId,
    db = getDb(),
  ) {
    await db
      .update(schema.forecastEvents)
      .set({ resolvedToTransactionId: transactionId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          eq(schema.forecastEvents.billOccurrenceId, billOccurrenceId),
          isNull(schema.forecastEvents.resolvedToTransactionId),
          isNull(schema.forecastEvents.deletedAt),
        ),
      );
  },
  async accountExists(userId, id, db = getDb()) {
    return (
      (
        await db
          .select({ id: schema.accounts.id })
          .from(schema.accounts)
          .where(
            and(
              eq(schema.accounts.userId, userId),
              eq(schema.accounts.id, id),
              isNull(schema.accounts.deletedAt),
            ),
          )
          .limit(1)
      ).length === 1
    );
  },
  async categoryExists(userId, id, db = getDb()) {
    return (
      (
        await db
          .select({ id: schema.categories.id })
          .from(schema.categories)
          .where(
            and(
              eq(schema.categories.id, id),
              isNull(schema.categories.archivedAt),
              sql`(${schema.categories.userId} IS NULL OR ${schema.categories.userId} = ${userId})`,
            ),
          )
          .limit(1)
      ).length === 1
    );
  },
  async recordAudit(audit, db = getDb()) {
    await db.insert(schema.auditLog).values({
      userId: audit.userId,
      entityType: audit.entityType,
      entityId: audit.entityId,
      action: audit.action,
      source: audit.source,
      ...(audit.before === undefined
        ? {}
        : { beforeJson: serialize(audit.before) }),
      ...(audit.after === undefined
        ? {}
        : { afterJson: serialize(audit.after) }),
    });
  },
};
export function createBillsRepository(db: Db): BillsRepository {
  return {
    list: (userId, statuses, tx) =>
      billsRepository.list(userId, statuses, tx ?? db),
    findById: (userId, id, tx) =>
      billsRepository.findById(userId, id, tx ?? db),
    insertManual: (userId, input, tx) =>
      billsRepository.insertManual(userId, input, tx ?? db),
    update: (userId, id, patch, tx) =>
      billsRepository.update(userId, id, patch, tx ?? db),
    softDelete: (userId, id, tx) =>
      billsRepository.softDelete(userId, id, tx ?? db),
    upsertDetected: (userId, rows, tx) =>
      billsRepository.upsertDetected(userId, rows, tx ?? db),
    updateDetection: (userId, rows, tx) =>
      billsRepository.updateDetection(userId, rows, tx ?? db),
    upsertForecastEvents: (rows, tx) =>
      billsRepository.upsertForecastEvents(rows, tx ?? db),
    upsertBillForecastEvents: (rows, tx) =>
      billsRepository.upsertBillForecastEvents(rows, tx ?? db),
    cancelFutureForecastEvents: (userId, id, tx) =>
      billsRepository.cancelFutureForecastEvents(userId, id, tx ?? db),
    detectionTransactions: (userId, tx) =>
      billsRepository.detectionTransactions(userId, tx ?? db),
    listRecentRecurringTransactions: (userId, tx) =>
      billsRepository.listRecentRecurringTransactions(userId, tx ?? db),
    listAutoConfirmationTransactions: (userId, from, to, tx) =>
      billsRepository.listAutoConfirmationTransactions(
        userId,
        from,
        to,
        tx ?? db,
      ),
    listOpenForecastEvents: (userId, ids, tx) =>
      billsRepository.listOpenForecastEvents(userId, ids, tx ?? db),
    resolveForecastEvent: (userId, eventId, transactionId, tx) =>
      billsRepository.resolveForecastEvent(
        userId,
        eventId,
        transactionId,
        tx ?? db,
      ),
    resolveBillForecastEvent: (userId, occurrenceId, transactionId, tx) =>
      billsRepository.resolveBillForecastEvent(
        userId,
        occurrenceId,
        transactionId,
        tx ?? db,
      ),
    accountExists: (userId, id, tx) =>
      billsRepository.accountExists(userId, id, tx ?? db),
    categoryExists: (userId, id, tx) =>
      billsRepository.categoryExists(userId, id, tx ?? db),
    recordAudit: (audit, tx) => billsRepository.recordAudit(audit, tx ?? db),
  };
}
