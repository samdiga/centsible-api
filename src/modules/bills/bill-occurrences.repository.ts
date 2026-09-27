import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { retiredSchedulePrefix } from "./bill-schedule.js";
import type { LinkedTransactionSummary } from "./bills.schemas.js";

export type BillOccurrenceRow = typeof schema.billOccurrences.$inferSelect;
type BillDb = Db | DbTransaction;
const effectiveDueDate = () =>
  sql`COALESCE(${schema.billOccurrences.dueDateOverride}, ${schema.billOccurrences.dueDate})`;
export type BillOccurrencesRepository = Readonly<{
  insertOccurrences: (
    rows: Array<{
      userId: string;
      billSetupId: string;
      occurrenceKey: string;
      dueDate: string;
      expectedAmountCents: bigint;
    }>,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow[]>;
  retireFutureSchedule: (
    userId: string,
    billId: string,
    today: string,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow[]>;
  adoptRetiredScheduleDate: (
    userId: string,
    billId: string,
    date: string,
    key: string,
    amount: bigint,
    db?: BillDb,
  ) => Promise<void>;
  listBySetup: (
    userId: string,
    billSetupId: string,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow[]>;
  currentForSetup: (
    userId: string,
    billSetupId: string,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow | null>;
  currentForSetups: (
    userId: string,
    billSetupIds: string[],
    db?: BillDb,
  ) => Promise<Map<string, BillOccurrenceRow>>;
  /** Name/date/amount of linked transactions, only those owned by the user. */
  linkedTransactionSummaries: (
    userId: string,
    transactionIds: string[],
    db?: BillDb,
  ) => Promise<Map<string, LinkedTransactionSummary>>;
  /** Earliest non-cancelled occurrence per setup with a due date in [dateFrom, dateTo]. */
  inRangeForSetups: (
    userId: string,
    billSetupIds: string[],
    dateFrom: string,
    dateTo: string,
    db?: BillDb,
  ) => Promise<Map<string, BillOccurrenceRow>>;
  /** Every non-cancelled occurrence per setup with a due date in [dateFrom, dateTo], by due date. */
  allInRangeForSetups: (
    userId: string,
    billSetupIds: string[],
    dateFrom: string,
    dateTo: string,
    db?: BillDb,
  ) => Promise<Map<string, BillOccurrenceRow[]>>;
  /** Setups that have at least one materialized occurrence, in any status. */
  setupIdsWithOccurrences: (
    userId: string,
    billSetupIds: string[],
    db?: BillDb,
  ) => Promise<Set<string>>;
  findById: (
    userId: string,
    id: string,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow | null>;
  findEditableOccurrence: (
    userId: string,
    billSetupId: string,
    occurrenceId: string,
    db?: BillDb,
  ) => Promise<(BillOccurrenceRow & { setupEndDate?: string | null }) | null>;
  hasActiveDateCollision: (
    userId: string,
    billSetupId: string,
    occurrenceId: string,
    dueDate: string,
    db?: BillDb,
  ) => Promise<boolean>;
  hasUnlinkedForecastIdentityCollision: (
    userId: string,
    billSetupId: string,
    dueDate: string,
    db?: BillDb,
  ) => Promise<boolean>;
  updateOccurrence: (
    userId: string,
    billSetupId: string,
    occurrenceId: string,
    patch: Partial<
      Pick<
        BillOccurrenceRow,
        | "expectedAmountOverrideCents"
        | "dueDateOverride"
        | "paymentOverrideCents"
      >
    >,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow | null>;
  updateLinkedForecastEvent: (
    userId: string,
    occurrenceId: string,
    dueDate: string,
    amountCents: bigint,
    db?: BillDb,
  ) => Promise<void>;
  updateIfStatus: (
    userId: string,
    id: string,
    statuses: BillOccurrenceRow["status"][],
    patch: Partial<
      Pick<
        BillOccurrenceRow,
        | "status"
        | "paidAmountCents"
        | "paidAccountId"
        | "linkedTransactionId"
        | "markedPaidAt"
        | "confirmedPaidAt"
        | "notes"
      >
    >,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow | null>;
  reconcileEndDate: (
    userId: string,
    billSetupId: string,
    endDate: string | null,
    today: string,
    db?: BillDb,
  ) => Promise<void>;
  cancelFuture: (
    userId: string,
    billSetupId: string,
    db?: BillDb,
  ) => Promise<void>;
  findProcessing: (
    userId: string,
    billSetupId: string,
    dateFrom: string,
    dateTo: string,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow | null>;
  listAutoConfirmationCandidates: (
    userId: string,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow[]>;
  sweepOverdue: (userId: string, db?: BillDb) => Promise<number>;
}>;

export const billOccurrencesRepository: BillOccurrencesRepository = {
  async insertOccurrences(rows, db = getDb()) {
    if (!rows.length) return [];
    return db
      .insert(schema.billOccurrences)
      .values(rows.map((row) => ({ ...row, status: "upcoming" as const })))
      .onConflictDoUpdate({
        target: [
          schema.billOccurrences.billSetupId,
          schema.billOccurrences.occurrenceKey,
        ],
        set: {
          dueDate: sql`CASE WHEN ${schema.billOccurrences.status} IN ('upcoming', 'overdue') THEN excluded.due_date ELSE ${schema.billOccurrences.dueDate} END`,
          expectedAmountCents: sql`CASE WHEN ${schema.billOccurrences.status} IN ('upcoming', 'overdue') THEN excluded.expected_amount_cents ELSE ${schema.billOccurrences.expectedAmountCents} END`,
          updatedAt: sql`CASE WHEN ${schema.billOccurrences.status} IN ('upcoming', 'overdue') THEN now() ELSE ${schema.billOccurrences.updatedAt} END`,
        },
      })
      .returning();
  },
  async retireFutureSchedule(userId, billId, today, db = getDb()) {
    const rows = await db
      .update(schema.billOccurrences)
      .set({
        status: "cancelled",
        cancelledByEndDate: null,
        occurrenceKey: sql`${retiredSchedulePrefix(billId)} || ${schema.billOccurrences.id}::text`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billId),
          sql`${effectiveDueDate()} >= ${today}`,
          isNull(schema.billOccurrences.dueDateOverride),
          isNull(schema.billOccurrences.expectedAmountOverrideCents),
          isNull(schema.billOccurrences.linkedTransactionId),
          isNull(schema.billOccurrences.markedPaidAt),
          isNull(schema.billOccurrences.paidAmountCents),
          isNull(schema.billOccurrences.confirmedPaidAt),
          sql`(${schema.billOccurrences.status} = 'upcoming' OR (${schema.billOccurrences.status} = 'cancelled' AND (${schema.billOccurrences.cancelledByEndDate} = true OR ${schema.billOccurrences.occurrenceKey} LIKE ${retiredSchedulePrefix(billId) + "%"})))`,
        ),
      )
      .returning();
    if (rows.length)
      await db
        .update(schema.forecastEvents)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.forecastEvents.userId, userId),
            inArray(
              schema.forecastEvents.billOccurrenceId,
              rows.map((row) => row.id),
            ),
            isNull(schema.forecastEvents.resolvedToTransactionId),
          ),
        );
    await db
      .update(schema.forecastEvents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          eq(schema.forecastEvents.recurringSeriesId, billId),
          isNull(schema.forecastEvents.billOccurrenceId),
          isNull(schema.forecastEvents.resolvedToTransactionId),
          eq(schema.forecastEvents.sourceType, "recurring"),
          sql`${schema.forecastEvents.date} >= ${today}`,
        ),
      );
    return rows;
  },
  async adoptRetiredScheduleDate(
    userId,
    billId,
    date,
    key,
    amount,
    db = getDb(),
  ) {
    const rows = await db
      .update(schema.billOccurrences)
      .set({
        status: "upcoming",
        occurrenceKey: key,
        expectedAmountCents: amount,
        cancelledByEndDate: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billId),
          eq(schema.billOccurrences.dueDate, date),
          eq(schema.billOccurrences.status, "cancelled"),
          sql`${schema.billOccurrences.occurrenceKey} LIKE ${retiredSchedulePrefix(billId) + "%"}`,
          isNull(schema.billOccurrences.dueDateOverride),
          isNull(schema.billOccurrences.expectedAmountOverrideCents),
          isNull(schema.billOccurrences.linkedTransactionId),
          isNull(schema.billOccurrences.markedPaidAt),
        ),
      )
      .returning({ id: schema.billOccurrences.id });
    if (rows.length)
      await db
        .update(schema.forecastEvents)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.forecastEvents.userId, userId),
            inArray(
              schema.forecastEvents.billOccurrenceId,
              rows.map((row) => row.id),
            ),
            isNull(schema.forecastEvents.resolvedToTransactionId),
          ),
        );
  },
  async listBySetup(userId, billSetupId, db = getDb()) {
    return db
      .select()
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billSetupId),
        ),
      )
      .orderBy(effectiveDueDate());
  },
  async currentForSetup(userId, billSetupId, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billSetupId),
          inArray(schema.billOccurrences.status, [
            "upcoming",
            "overdue",
            "processing",
          ]),
        ),
      )
      .orderBy(effectiveDueDate())
      .limit(1);
    return rows[0] ?? null;
  },
  async currentForSetups(userId, ids, db = getDb()) {
    if (!ids.length) return new Map();
    const rows = await db
      .selectDistinctOn([schema.billOccurrences.billSetupId])
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          inArray(schema.billOccurrences.billSetupId, ids),
          inArray(schema.billOccurrences.status, [
            "upcoming",
            "overdue",
            "processing",
          ]),
        ),
      )
      .orderBy(schema.billOccurrences.billSetupId, effectiveDueDate());
    return new Map(rows.map((row) => [row.billSetupId, row]));
  },
  async linkedTransactionSummaries(userId, transactionIds, db = getDb()) {
    if (transactionIds.length === 0) return new Map();
    const rows = await db
      .select({
        id: schema.transactions.id,
        merchantName: schema.transactions.merchantName,
        name: schema.transactions.name,
        date: schema.transactions.date,
        amount: schema.transactions.amount,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, transactionIds),
        ),
      );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.merchantName?.trim() || row.name,
          date: row.date,
          amountCents: row.amount.toString(),
        },
      ]),
    );
  },
  async inRangeForSetups(userId, ids, dateFrom, dateTo, db = getDb()) {
    if (!ids.length) return new Map();
    const rows = await db
      .selectDistinctOn([schema.billOccurrences.billSetupId])
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          inArray(schema.billOccurrences.billSetupId, ids),
          ne(schema.billOccurrences.status, "cancelled"),
          sql`${effectiveDueDate()} >= ${dateFrom}`,
          sql`${effectiveDueDate()} <= ${dateTo}`,
        ),
      )
      .orderBy(schema.billOccurrences.billSetupId, effectiveDueDate());
    return new Map(rows.map((row) => [row.billSetupId, row]));
  },
  async allInRangeForSetups(userId, ids, dateFrom, dateTo, db = getDb()) {
    if (!ids.length) return new Map();
    const rows = await db
      .select()
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          inArray(schema.billOccurrences.billSetupId, ids),
          ne(schema.billOccurrences.status, "cancelled"),
          sql`${effectiveDueDate()} >= ${dateFrom}`,
          sql`${effectiveDueDate()} <= ${dateTo}`,
        ),
      )
      .orderBy(schema.billOccurrences.billSetupId, effectiveDueDate());
    const bySetup = new Map<string, BillOccurrenceRow[]>();
    for (const row of rows)
      bySetup.set(row.billSetupId, [...(bySetup.get(row.billSetupId) ?? []), row]);
    return bySetup;
  },
  async setupIdsWithOccurrences(userId, ids, db = getDb()) {
    if (!ids.length) return new Set();
    const rows = await db
      .selectDistinct({ billSetupId: schema.billOccurrences.billSetupId })
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          inArray(schema.billOccurrences.billSetupId, ids),
        ),
      );
    return new Set(rows.map((row) => row.billSetupId));
  },
  async findById(userId, id, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async findEditableOccurrence(
    userId,
    billSetupId,
    occurrenceId,
    db = getDb(),
  ) {
    const rows = await db
      .select({
        occurrence: schema.billOccurrences,
        setupEndDate: schema.billSetup.endDate,
      })
      .from(schema.billOccurrences)
      .innerJoin(
        schema.billSetup,
        and(
          eq(schema.billSetup.id, schema.billOccurrences.billSetupId),
          eq(schema.billSetup.userId, schema.billOccurrences.userId),
          isNull(schema.billSetup.deletedAt),
        ),
      )
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billSetupId),
          eq(schema.billOccurrences.id, occurrenceId),
        ),
      )
      .for("update")
      .limit(1);
    return rows[0]
      ? { ...rows[0].occurrence, setupEndDate: rows[0].setupEndDate }
      : null;
  },
  async hasActiveDateCollision(
    userId,
    billSetupId,
    occurrenceId,
    dueDate,
    db = getDb(),
  ) {
    const rows = await db
      .select({ id: schema.billOccurrences.id })
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billSetupId),
          ne(schema.billOccurrences.id, occurrenceId),
          inArray(schema.billOccurrences.status, [
            "upcoming",
            "overdue",
            "processing",
          ]),
          sql`COALESCE(${schema.billOccurrences.dueDateOverride}, ${schema.billOccurrences.dueDate}) = ${dueDate}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  },
  async hasUnlinkedForecastIdentityCollision(
    userId,
    billSetupId,
    dueDate,
    db = getDb(),
  ) {
    const rows = await db
      .select({ id: schema.forecastEvents.id })
      .from(schema.forecastEvents)
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          eq(schema.forecastEvents.recurringSeriesId, billSetupId),
          eq(schema.forecastEvents.date, dueDate),
          isNull(schema.forecastEvents.billOccurrenceId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },
  async updateOccurrence(
    userId,
    billSetupId,
    occurrenceId,
    patch,
    db = getDb(),
  ) {
    const rows = await db
      .update(schema.billOccurrences)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billSetupId),
          eq(schema.billOccurrences.id, occurrenceId),
          inArray(schema.billOccurrences.status, ["upcoming", "overdue"]),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async updateLinkedForecastEvent(
    userId,
    occurrenceId,
    dueDate,
    amountCents,
    db = getDb(),
  ) {
    await db
      .update(schema.forecastEvents)
      .set({ date: dueDate, amount: amountCents, updatedAt: new Date() })
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          eq(schema.forecastEvents.billOccurrenceId, occurrenceId),
          isNull(schema.forecastEvents.resolvedToTransactionId),
          isNull(schema.forecastEvents.deletedAt),
        ),
      );
  },
  async updateIfStatus(userId, id, statuses, patch, db = getDb()) {
    const rows = await db
      .update(schema.billOccurrences)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.id, id),
          inArray(schema.billOccurrences.status, statuses),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async reconcileEndDate(userId, billSetupId, endDate, today, db = getDb()) {
    const scope = and(
      eq(schema.billOccurrences.userId, userId),
      eq(schema.billOccurrences.billSetupId, billSetupId),
      sql`${effectiveDueDate()} >= ${today}`,
    );
    // Restore only our own future cancellations, never paid, processing or manually cancelled rows.
    const restored = await db
      .update(schema.billOccurrences)
      .set({
        status: "upcoming",
        cancelledByEndDate: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          scope,
          eq(schema.billOccurrences.status, "cancelled"),
          eq(schema.billOccurrences.cancelledByEndDate, true),
          endDate === null
            ? undefined
            : sql`${effectiveDueDate()} <= ${endDate}`,
        ),
      )
      .returning({ id: schema.billOccurrences.id });
    if (restored.length)
      await db
        .update(schema.forecastEvents)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.forecastEvents.userId, userId),
            inArray(
              schema.forecastEvents.billOccurrenceId,
              restored.map((row) => row.id),
            ),
            isNull(schema.forecastEvents.resolvedToTransactionId),
          ),
        );
    if (endDate === null) return;
    await db
      .update(schema.billOccurrences)
      .set({
        status: "cancelled",
        cancelledByEndDate: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          scope,
          eq(schema.billOccurrences.status, "upcoming"),
          sql`${effectiveDueDate()} > ${endDate}`,
        ),
      )
      .returning({ id: schema.billOccurrences.id });
    // Use the occurrence's effective date, including a user date override.
    await db
      .update(schema.forecastEvents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.forecastEvents.userId, userId),
          eq(schema.forecastEvents.recurringSeriesId, billSetupId),
          isNull(schema.forecastEvents.resolvedToTransactionId),
          isNull(schema.forecastEvents.deletedAt),
          sql`((${schema.forecastEvents.billOccurrenceId} IS NULL AND ${schema.forecastEvents.date} >= ${today} AND ${schema.forecastEvents.date} > ${endDate}) OR ${schema.forecastEvents.billOccurrenceId} IN (SELECT id FROM ${schema.billOccurrences} WHERE user_id = ${userId} AND bill_setup_id = ${billSetupId} AND cancelled_by_end_date = true AND status = 'cancelled'))`,
        ),
      );
  },
  async cancelFuture(userId, billSetupId, db = getDb()) {
    await db
      .update(schema.billOccurrences)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billSetupId),
          eq(schema.billOccurrences.status, "upcoming"),
        ),
      );
  },
  async findProcessing(userId, billSetupId, dateFrom, dateTo, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.billSetupId, billSetupId),
          eq(schema.billOccurrences.status, "processing"),
          sql`${effectiveDueDate()} >= ${dateFrom}`,
          sql`${effectiveDueDate()} <= ${dateTo}`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async listAutoConfirmationCandidates(userId, db = getDb()) {
    return db
      .select()
      .from(schema.billOccurrences)
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          inArray(schema.billOccurrences.status, [
            "upcoming",
            "overdue",
            "processing",
          ]),
        ),
      );
  },
  async sweepOverdue(userId, db = getDb()) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db
      .update(schema.billOccurrences)
      .set({ status: "overdue", updatedAt: new Date() })
      .where(
        and(
          eq(schema.billOccurrences.userId, userId),
          eq(schema.billOccurrences.status, "upcoming"),
          sql`${effectiveDueDate()} <= ${today}`,
        ),
      )
      .returning({ id: schema.billOccurrences.id });
    return rows.length;
  },
};

export function createBillOccurrencesRepository(
  db: Db,
): BillOccurrencesRepository {
  return {
    insertOccurrences: (rows, tx) =>
      billOccurrencesRepository.insertOccurrences(rows, tx ?? db),
    retireFutureSchedule: (userId, id, today, tx) =>
      billOccurrencesRepository.retireFutureSchedule(
        userId,
        id,
        today,
        tx ?? db,
      ),
    adoptRetiredScheduleDate: (userId, id, date, key, amount, tx) =>
      billOccurrencesRepository.adoptRetiredScheduleDate(
        userId,
        id,
        date,
        key,
        amount,
        tx ?? db,
      ),
    listBySetup: (userId, id, tx) =>
      billOccurrencesRepository.listBySetup(userId, id, tx ?? db),
    currentForSetup: (userId, id, tx) =>
      billOccurrencesRepository.currentForSetup(userId, id, tx ?? db),
    currentForSetups: (userId, ids, tx) =>
      billOccurrencesRepository.currentForSetups(userId, ids, tx ?? db),
    linkedTransactionSummaries: (userId, ids, tx) =>
      billOccurrencesRepository.linkedTransactionSummaries(
        userId,
        ids,
        tx ?? db,
      ),
    inRangeForSetups: (userId, ids, from, to, tx) =>
      billOccurrencesRepository.inRangeForSetups(
        userId,
        ids,
        from,
        to,
        tx ?? db,
      ),
    allInRangeForSetups: (userId, ids, from, to, tx) =>
      billOccurrencesRepository.allInRangeForSetups(
        userId,
        ids,
        from,
        to,
        tx ?? db,
      ),
    setupIdsWithOccurrences: (userId, ids, tx) =>
      billOccurrencesRepository.setupIdsWithOccurrences(userId, ids, tx ?? db),
    findById: (userId, id, tx) =>
      billOccurrencesRepository.findById(userId, id, tx ?? db),
    findEditableOccurrence: (userId, billId, occurrenceId, tx) =>
      billOccurrencesRepository.findEditableOccurrence(
        userId,
        billId,
        occurrenceId,
        tx ?? db,
      ),
    hasActiveDateCollision: (userId, billId, occurrenceId, dueDate, tx) =>
      billOccurrencesRepository.hasActiveDateCollision(
        userId,
        billId,
        occurrenceId,
        dueDate,
        tx ?? db,
      ),
    hasUnlinkedForecastIdentityCollision: (userId, billId, dueDate, tx) =>
      billOccurrencesRepository.hasUnlinkedForecastIdentityCollision(
        userId,
        billId,
        dueDate,
        tx ?? db,
      ),
    updateOccurrence: (userId, billId, occurrenceId, patch, tx) =>
      billOccurrencesRepository.updateOccurrence(
        userId,
        billId,
        occurrenceId,
        patch,
        tx ?? db,
      ),
    updateLinkedForecastEvent: (
      userId,
      occurrenceId,
      dueDate,
      amountCents,
      tx,
    ) =>
      billOccurrencesRepository.updateLinkedForecastEvent(
        userId,
        occurrenceId,
        dueDate,
        amountCents,
        tx ?? db,
      ),
    updateIfStatus: (userId, id, statuses, patch, tx) =>
      billOccurrencesRepository.updateIfStatus(
        userId,
        id,
        statuses,
        patch,
        tx ?? db,
      ),
    reconcileEndDate: (userId, id, endDate, today, tx) =>
      billOccurrencesRepository.reconcileEndDate(
        userId,
        id,
        endDate,
        today,
        tx ?? db,
      ),
    cancelFuture: (userId, id, tx) =>
      billOccurrencesRepository.cancelFuture(userId, id, tx ?? db),
    findProcessing: (userId, id, from, to, tx) =>
      billOccurrencesRepository.findProcessing(userId, id, from, to, tx ?? db),
    listAutoConfirmationCandidates: (userId, tx) =>
      billOccurrencesRepository.listAutoConfirmationCandidates(
        userId,
        tx ?? db,
      ),
    sweepOverdue: (userId, tx) =>
      billOccurrencesRepository.sweepOverdue(userId, tx ?? db),
  };
}
