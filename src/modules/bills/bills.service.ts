import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  getUserRevision,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../platform/errors/app-error.js";
import { toBillDto, toBillOccurrenceDto } from "./bills.mapper.js";
import {
  billOccurrencesRepository,
  type BillOccurrencesRepository,
} from "./bill-occurrences.repository.js";
import { billsRepository, type BillsRepository } from "./bills.repository.js";
import { detectRecurring } from "./recurring-engine.js";
import {
  nextDateForCadence,
  type RecurringCadence,
} from "./recurring-engine.js";
import type {
  BillDto,
  BillOccurrenceDto,
  CreateBillInput,
  MarkBillPaidInput,
  UpdateBillInput,
} from "./bills.schemas.js";

/** Narrow job port. The default is deliberately inert until the Plan 3 worker adapter is composed. */
export type BillJobDispatcher = Readonly<{
  detect: (userId: string) => Promise<void>;
  materialize: (userId: string, billId: string) => Promise<void>;
}>;
const safeDispatcher: BillJobDispatcher = {
  detect: async () => undefined,
  materialize: async () => undefined,
};
export type BillsService = Readonly<{
  listBills: (
    userId: string,
    month?: string,
  ) => Promise<{ series: BillDto[]; pendingCount: number }>;
  createBill: (userId: string, input: CreateBillInput) => Promise<BillDto>;
  updateBill: (
    userId: string,
    id: string,
    input: UpdateBillInput,
  ) => Promise<BillDto>;
  deleteBill: (userId: string, id: string) => Promise<boolean>;
  getBill: (userId: string, id: string) => Promise<BillDto>;
  listOccurrences: (userId: string, id: string) => Promise<BillOccurrenceDto[]>;
  markOccurrencePaid: (
    userId: string,
    occurrenceId: string,
    input: MarkBillPaidInput,
  ) => Promise<void>;
  skipOccurrence: (userId: string, occurrenceId: string) => Promise<void>;
  queueDetection: (userId: string) => Promise<void>;
}>;
export type BillsServiceDependencies = Readonly<{
  repository?: BillsRepository;
  occurrences?: BillOccurrencesRepository;
  cache?: Pick<ResponseCache, "getOrCompute" | "invalidateUser">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
  dispatcher?: BillJobDispatcher;
}>;
const mutation = (
  cache: Pick<ResponseCache, "invalidateUser">,
): UserMutationService["withUserMutation"] =>
  createWithUserMutation({ db: getDb(), cache });
const assertReference = async (exists: Promise<boolean>, field: string) => {
  if (!(await exists))
    throw new ValidationError(
      `${field} does not exist or is not accessible to this user.`,
    );
};
const listQuery = (month?: string) => (month ? { month: [month] } : {});

export function createBillsService(
  dependencies: BillsServiceDependencies = {},
): BillsService {
  const repository = dependencies.repository ?? billsRepository;
  const occurrences = dependencies.occurrences ?? billOccurrencesRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const revision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const mutate =
    dependencies.withUserMutation ??
    ((userId, callback) => mutation(cache)(userId, callback));
  const dispatcher = dependencies.dispatcher ?? safeDispatcher;
  const assertReferences = async (
    userId: string,
    input: {
      accountId?: string | null | undefined;
      toAccountId?: string | null | undefined;
      categoryId?: string | null | undefined;
    },
    tx?: DbTransaction,
  ) => {
    if (input.accountId)
      await assertReference(
        repository.accountExists(userId, input.accountId, tx),
        "accountId",
      );
    if (input.toAccountId)
      await assertReference(
        repository.accountExists(userId, input.toAccountId, tx),
        "toAccountId",
      );
    if (input.categoryId)
      await assertReference(
        repository.categoryExists(userId, input.categoryId, tx),
        "categoryId",
      );
  };
  return {
    async listBills(userId, month) {
      const read = async () => {
        const rows = await repository.list(
          userId,
          month ? ["active"] : ["active", "pending_confirmation"],
          month,
        );
        const current = await occurrences.currentForSetups(
          userId,
          rows.map((row) => row.id),
        );
        return {
          series: rows.map((row) => toBillDto(row, current.get(row.id))),
          pendingCount: month
            ? 0
            : rows.filter((row) => row.status === "pending_confirmation")
                .length,
        };
      };
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/bills",
          query: listQuery(month),
          revision: await revision(userId),
        },
        read,
      );
    },
    async createBill(userId, input) {
      const created = await mutate(userId, async (tx) => {
        await assertReferences(userId, input, tx);
        const row = await repository.insertManual(
          userId,
          {
            canonicalName: input.canonicalName,
            cadence: input.cadence,
            avgAmount: input.amountCents,
            nextExpectedDate: input.nextExpectedDate,
            categoryId: input.categoryId ?? null,
            accountId: input.accountId ?? null,
            isIncome: input.isIncome ?? false,
            notes: input.notes ?? null,
            billType: input.billType ?? "payable",
            toAccountId: input.toAccountId ?? null,
          },
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_setup",
            entityId: row.id,
            action: "create",
            source: "bills.create",
            after: row,
          },
          tx,
        );
        return row;
      });
      await dispatcher.materialize(userId, created.id);
      return toBillDto(created);
    },
    async updateBill(userId, id, input) {
      const updated = await mutate(userId, async (tx) => {
        const before = await repository.findById(userId, id, tx);
        if (!before) throw new NotFoundError("bill");
        await assertReferences(userId, input, tx);
        if (input.status === "paused" || input.status === "ended")
          await repository.cancelFutureForecastEvents(userId, id, tx);
        if (input.status === "paused" || input.status === "ended")
          await occurrences.cancelFuture(userId, id, tx);
        const row = await repository.update(userId, id, input, tx);
        if (!row) throw new NotFoundError("bill");
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_setup",
            entityId: id,
            action: "update",
            source: "bills.update",
            before,
            after: row,
          },
          tx,
        );
        return row;
      });
      if (updated.status === "active" && updated.userConfirmed)
        await dispatcher.materialize(userId, id);
      return toBillDto(updated);
    },
    async deleteBill(userId, id) {
      await mutate(userId, async (tx) => {
        const before = await repository.findById(userId, id, tx);
        if (!before) throw new NotFoundError("bill");
        await repository.cancelFutureForecastEvents(userId, id, tx);
        await occurrences.cancelFuture(userId, id, tx);
        if (!(await repository.softDelete(userId, id, tx)))
          throw new NotFoundError("bill");
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_setup",
            entityId: id,
            action: "delete",
            source: "bills.delete",
            before,
          },
          tx,
        );
      });
      return true;
    },
    async getBill(userId, id) {
      const read = async () => {
        const row = await repository.findById(userId, id);
        if (!row) throw new NotFoundError("bill");
        return toBillDto(row, await occurrences.currentForSetup(userId, id));
      };
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/bills/:id",
          query: { id: [id] },
          revision: await revision(userId),
        },
        read,
      );
    },
    async listOccurrences(userId, id) {
      const read = async () => {
        if (!(await repository.findById(userId, id)))
          throw new NotFoundError("bill");
        return (await occurrences.listBySetup(userId, id))
          .reverse()
          .map(toBillOccurrenceDto);
      };
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/bills/:id/occurrences",
          query: { id: [id] },
          revision: await revision(userId),
        },
        read,
      );
    },
    async markOccurrencePaid(userId, occurrenceId, input) {
      await mutate(userId, async (tx) => {
        const before = await occurrences.findById(userId, occurrenceId, tx);
        if (!before) throw new NotFoundError("bill occurrence");
        if (before.status !== "upcoming" && before.status !== "overdue")
          throw new ConflictError("Bill occurrence cannot be marked paid");
        await assertReference(
          repository.accountExists(userId, input.accountId, tx),
          "accountId",
        );
        const updated = await occurrences.updateIfStatus(
          userId,
          occurrenceId,
          ["upcoming", "overdue"],
          {
            status: "processing",
            paidAmountCents: input.amountCents,
            paidAccountId: input.accountId,
            markedPaidAt: new Date(),
          },
          tx,
        );
        if (!updated)
          throw new ConflictError("Bill occurrence cannot be marked paid");
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_occurrence",
            entityId: occurrenceId,
            action: "update",
            source: "bills.mark_paid",
            before,
            after: updated,
          },
          tx,
        );
      });
    },
    async skipOccurrence(userId, occurrenceId) {
      await mutate(userId, async (tx) => {
        const before = await occurrences.findById(userId, occurrenceId, tx);
        if (!before) throw new NotFoundError("bill occurrence");
        if (before.status !== "upcoming" && before.status !== "overdue")
          throw new ConflictError("Bill occurrence cannot be skipped");
        const updated = await occurrences.updateIfStatus(
          userId,
          occurrenceId,
          ["upcoming", "overdue"],
          { status: "skipped" },
          tx,
        );
        if (!updated)
          throw new ConflictError("Bill occurrence cannot be skipped");
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_occurrence",
            entityId: occurrenceId,
            action: "update",
            source: "bills.skip",
            before,
            after: updated,
          },
          tx,
        );
      });
    },
    async queueDetection(userId) {
      await dispatcher.detect(userId);
    },
  };
}

/** Worker-facing detection entry point; its writes participate in the same user revision protocol. */
export async function runBillDetection(
  userId: string,
  dependencies: BillsServiceDependencies = {},
): Promise<{ created: number; updated: number }> {
  const repository = dependencies.repository ?? billsRepository;
  const raw = await repository.detectionTransactions(userId);
  const existing = await repository.list(userId, [
    "active",
    "paused",
    "ended",
    "pending_confirmation",
  ]);
  const result = detectRecurring(
    raw,
    existing.map((row) => ({
      id: row.id,
      canonicalName: row.canonicalName,
      cadence: row.cadence,
      status: row.status,
      avgAmountCents: row.avgAmount,
      lastOccurredOn: row.lastOccurredOn,
      nextExpectedDate: row.nextExpectedDate,
    })),
  );
  const cache = dependencies.cache ?? createResponseCache();
  const mutate =
    dependencies.withUserMutation ??
    ((id, callback) => mutation(cache)(id, callback));
  await mutate(userId, async (tx) => {
    await repository.upsertDetected(userId, result.toInsert, tx);
    await repository.updateDetection(userId, result.toUpdate, tx);
    return undefined;
  });
  return { created: result.toInsert.length, updated: result.toUpdate.length };
}

/** Materializes confirmed regular bills into idempotent forecast events and occurrences. */
export async function materializeBillsForUser(
  userId: string,
  billId?: string,
  horizonMonths = 12,
  dependencies: BillsServiceDependencies = {},
): Promise<{ setupsMaterialized: number; occurrencesCreated: number }> {
  const repository = dependencies.repository ?? billsRepository;
  const occurrences = dependencies.occurrences ?? billOccurrencesRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const mutate =
    dependencies.withUserMutation ??
    ((id, callback) => mutation(cache)(id, callback));
  return mutate(userId, async (tx) => {
    const all = await repository.list(userId, ["active"], undefined, tx);
    const candidates = all.filter(
      (row) => (!billId || row.id === billId) && row.userConfirmed,
    );
    const today = new Date().toISOString().slice(0, 10);
    const [year, month, day] = today.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    const horizon = new Date(Date.UTC(year, month - 1 + horizonMonths, day));
    let setupsMaterialized = 0;
    let occurrencesCreated = 0;
    for (const bill of candidates) {
      if (
        !bill.nextExpectedDate ||
        bill.cadence === "semimonthly" ||
        bill.cadence === "irregular" ||
        bill.cadence === "daily"
      )
        continue;
      const cadence = bill.cadence as Exclude<
        RecurringCadence,
        "semimonthly" | "irregular"
      >;
      let cursor = bill.nextExpectedDate;
      while (cursor < today) cursor = nextDateForCadence(cursor, cadence);
      const dates: string[] = [];
      while (Date.parse(`${cursor}T00:00:00Z`) <= horizon.getTime()) {
        dates.push(cursor);
        cursor = nextDateForCadence(cursor, cadence);
      }
      if (!dates.length) continue;
      setupsMaterialized += 1;
      occurrencesCreated += dates.length;
      await repository.upsertForecastEvents(
        dates.map((date) => ({
          userId,
          accountId: bill.accountId,
          name: bill.canonicalName,
          amountCents: bill.avgAmount,
          date,
          categoryId: bill.categoryId,
          recurringSeriesId: bill.id,
        })),
        tx,
      );
      await occurrences.insertOccurrences(
        dates.map((dueDate) => ({
          userId,
          billSetupId: bill.id,
          dueDate,
          expectedAmountCents: bill.avgAmount,
        })),
        tx,
      );
    }
    return { setupsMaterialized, occurrencesCreated };
  });
}
