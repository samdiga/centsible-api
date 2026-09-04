import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

export type BillOccurrenceRow = typeof schema.billOccurrences.$inferSelect;
type BillDb = Db | DbTransaction;
export type BillOccurrencesRepository = Readonly<{
  insertOccurrences: (
    rows: Array<{
      userId: string;
      billSetupId: string;
      dueDate: string;
      expectedAmountCents: bigint;
    }>,
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
  findById: (
    userId: string,
    id: string,
    db?: BillDb,
  ) => Promise<BillOccurrenceRow | null>;
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
}>;

export const billOccurrencesRepository: BillOccurrencesRepository = {
  async insertOccurrences(rows, db = getDb()) {
    if (!rows.length) return;
    await db
      .insert(schema.billOccurrences)
      .values(rows.map((row) => ({ ...row, status: "upcoming" as const })))
      .onConflictDoNothing({
        target: [
          schema.billOccurrences.billSetupId,
          schema.billOccurrences.dueDate,
        ],
      });
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
      .orderBy(schema.billOccurrences.dueDate);
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
      .orderBy(schema.billOccurrences.dueDate)
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
      .orderBy(
        schema.billOccurrences.billSetupId,
        schema.billOccurrences.dueDate,
      );
    return new Map(rows.map((row) => [row.billSetupId, row]));
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
    findById: (userId, id, tx) =>
      billOccurrencesRepository.findById(userId, id, tx ?? db),
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
  };
}
