import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

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
  /** Earliest non-cancelled occurrence per setup with a due date in [dateFrom, dateTo]. */
  inRangeForSetups: (
    userId: string,
    billSetupIds: string[],
    dateFrom: string,
    dateTo: string,
    db?: BillDb,
  ) => Promise<Map<string, BillOccurrenceRow>>;
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
  ) => Promise<BillOccurrenceRow | null>;
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
      Pick<BillOccurrenceRow, "expectedAmountOverrideCents" | "dueDateOverride">
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
          dueDate: sql`CASE WHEN ${schema.billOccurrences.status} IN ('upcoming', 'overdue', 'processing') THEN excluded.due_date ELSE ${schema.billOccurrences.dueDate} END`,
          expectedAmountCents: sql`CASE WHEN ${schema.billOccurrences.status} IN ('upcoming', 'overdue', 'processing') THEN excluded.expected_amount_cents ELSE ${schema.billOccurrences.expectedAmountCents} END`,
          updatedAt: sql`CASE WHEN ${schema.billOccurrences.status} IN ('upcoming', 'overdue', 'processing') THEN now() ELSE ${schema.billOccurrences.updatedAt} END`,
        },
      })
      .returning();
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
      .select({ occurrence: schema.billOccurrences })
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
    return rows[0]?.occurrence ?? null;
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
    listBySetup: (userId, id, tx) =>
      billOccurrencesRepository.listBySetup(userId, id, tx ?? db),
    currentForSetup: (userId, id, tx) =>
      billOccurrencesRepository.currentForSetup(userId, id, tx ?? db),
    currentForSetups: (userId, ids, tx) =>
      billOccurrencesRepository.currentForSetups(userId, ids, tx ?? db),
    inRangeForSetups: (userId, ids, from, to, tx) =>
      billOccurrencesRepository.inRangeForSetups(
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
    cancelFuture: (userId, id, tx) =>
      billOccurrencesRepository.cancelFuture(userId, id, tx ?? db),
    findProcessing: (userId, id, from, to, tx) =>
      billOccurrencesRepository.findProcessing(userId, id, from, to, tx ?? db),
    sweepOverdue: (userId, tx) =>
      billOccurrencesRepository.sweepOverdue(userId, tx ?? db),
  };
}
