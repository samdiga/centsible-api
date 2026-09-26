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
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../platform/errors/app-error.js";
import { toBillDto, toBillOccurrenceDto } from "./bills.mapper.js";
import {
  billOccurrencesRepository,
  type BillOccurrenceRow,
  type BillOccurrencesRepository,
} from "./bill-occurrences.repository.js";
import {
  billsRepository,
  monthEnd,
  type BillRow,
  type BillsRepository,
} from "./bills.repository.js";
import {
  detectRecurring,
  nextDateForCadence,
  type RecurringCadence,
} from "./recurring-engine.js";
import { upsertStatementBills } from "./statement-bills.js";
import type {
  BillDto,
  BillOccurrenceDto,
  CreateBillInput,
  MarkBillPaidInput,
  UpdateBillOccurrenceInput,
  UpdateBillInput,
  LinkedTransactionSummary,
} from "./bills.schemas.js";

/** Narrow job port supplied by the Plan 3 worker adapter. */
export type BillJobDispatcher = Readonly<{
  detect: (userId: string) => Promise<void>;
  materialize: (userId: string, billId: string) => Promise<void>;
}>;
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
  updateOccurrence: (
    userId: string,
    billSetupId: string,
    occurrenceId: string,
    input: UpdateBillOccurrenceInput,
  ) => Promise<BillOccurrenceDto>;
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
  billDispatcher?: BillJobDispatcher;
  statementBills?: (
    userId: string,
  ) => Promise<{ created: number; updated: number }>;
  now?: (() => Date) | undefined;
  workerLogger?:
    | { debug: (bindings: Record<string, unknown>, message: string) => void }
    | undefined;
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
  const billDispatcher = dependencies.billDispatcher;
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
  /**
   * A month view lists every active bill with an occurrence due that month and
   * shows that occurrence, whatever its status. `nextExpectedDate` is a single,
   * possibly stale date per bill, so it only decides membership for bills with
   * no materialized occurrences (semimonthly, irregular, not yet materialized).
   */
  /** Summaries for the occurrences' linked transactions, in one query. */
  const linkedFor = async (
    userId: string,
    rows: ReadonlyArray<BillOccurrenceRow | null | undefined>,
    tx?: DbTransaction,
  ): Promise<ReadonlyMap<string, LinkedTransactionSummary>> => {
    const ids = rows.flatMap((row) =>
      row?.linkedTransactionId ? [row.linkedTransactionId] : [],
    );
    if (ids.length === 0) return new Map();
    return occurrences.linkedTransactionSummaries(userId, ids, tx);
  };

  const listMonth = async (userId: string, month: string) => {
    const monthStart = `${month}-01`;
    const lastDay = monthEnd(month);
    const rows = await repository.list(userId, ["active"]);
    const ids = rows.map((row) => row.id);
    const [inMonth, materialized] = await Promise.all([
      occurrences.inRangeForSetups(userId, ids, monthStart, lastDay),
      occurrences.setupIdsWithOccurrences(userId, ids),
    ]);
    const dueIn = (row: BillRow) => {
      const occurrence = inMonth.get(row.id);
      return occurrence
        ? (occurrence.dueDateOverride ?? occurrence.dueDate)
        : row.nextExpectedDate;
    };
    const linked = await linkedFor(userId, [...inMonth.values()]);
    return rows
      .filter((row) => {
        if (inMonth.has(row.id)) return true;
        if (materialized.has(row.id) || !row.nextExpectedDate) return false;
        return (
          row.nextExpectedDate >= monthStart && row.nextExpectedDate <= lastDay
        );
      })
      .sort((a, b) => (dueIn(a) ?? "").localeCompare(dueIn(b) ?? ""))
      .map((row) => toBillDto(row, inMonth.get(row.id) ?? null, linked));
  };
  return {
    async listBills(userId, month) {
      const read = async () => {
        if (month)
          return { series: await listMonth(userId, month), pendingCount: 0 };
        const rows = await repository.list(userId, [
          "active",
          "pending_confirmation",
        ]);
        const current = await occurrences.currentForSetups(
          userId,
          rows.map((row) => row.id),
        );
        const linked = await linkedFor(userId, [...current.values()]);
        return {
          series: rows.map((row) =>
            toBillDto(row, current.get(row.id), linked),
          ),
          pendingCount: rows.filter(
            (row) => row.status === "pending_confirmation",
          ).length,
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
      if (!billDispatcher) throw new ServiceUnavailableError();
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
      await billDispatcher.materialize(userId, created.id);
      return toBillDto(created);
    },
    async updateBill(userId, id, input) {
      const updated = await mutate(userId, async (tx) => {
        const before = await repository.findById(userId, id, tx);
        if (!before) throw new NotFoundError("bill");
        const shouldMaterialize =
          (input.status ?? before.status) === "active" &&
          (input.userConfirmed ?? before.userConfirmed) === true;
        if (shouldMaterialize && !billDispatcher)
          throw new ServiceUnavailableError();
        await assertReferences(userId, input, tx);
        if (input.status === "paused" || input.status === "ended")
          await repository.cancelFutureForecastEvents(userId, id, tx);
        if (input.status === "paused" || input.status === "ended")
          await occurrences.cancelFuture(userId, id, tx);
        const row = await repository.update(userId, id, input, tx);
        if (!row) throw new NotFoundError("bill");
        if (row.status === "active" && row.userConfirmed && !billDispatcher)
          throw new ServiceUnavailableError();
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
        await billDispatcher!.materialize(userId, id);
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
        const current = await occurrences.currentForSetup(userId, id);
        return toBillDto(row, current, await linkedFor(userId, [current]));
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
        const rows = (await occurrences.listBySetup(userId, id)).reverse();
        const linked = await linkedFor(userId, rows);
        return rows.map((row) => toBillOccurrenceDto(row, linked));
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
    async updateOccurrence(userId, billSetupId, occurrenceId, input) {
      return mutate(userId, async (tx) => {
        const before = await occurrences.findEditableOccurrence(
          userId,
          billSetupId,
          occurrenceId,
          tx,
        );
        if (!before) throw new NotFoundError("bill occurrence");
        if (before.status !== "upcoming" && before.status !== "overdue")
          throw new ConflictError("Bill occurrence cannot be edited");

        // Omitted keeps the current value; null clears the override so the
        // scheduled baseline applies again.
        const currentDate = before.dueDateOverride ?? before.dueDate;
        const dueDate =
          input.dueDate === undefined
            ? currentDate
            : (input.dueDate ?? before.dueDate);
        const amountCents =
          input.amountCents === undefined
            ? (before.expectedAmountOverrideCents ?? before.expectedAmountCents)
            : (input.amountCents ?? before.expectedAmountCents);
        if (dueDate !== currentDate) {
          const [activeCollision, forecastCollision] = await Promise.all([
            occurrences.hasActiveDateCollision(
              userId,
              billSetupId,
              occurrenceId,
              dueDate,
              tx,
            ),
            occurrences.hasUnlinkedForecastIdentityCollision(
              userId,
              billSetupId,
              dueDate,
              tx,
            ),
          ]);
          if (activeCollision || forecastCollision)
            throw new ConflictError("Bill occurrence date is already in use");
        }

        const patch = {
          ...(input.amountCents === undefined
            ? {}
            : { expectedAmountOverrideCents: input.amountCents }),
          ...(input.dueDate === undefined
            ? {}
            : { dueDateOverride: input.dueDate }),
        };
        const after = await occurrences.updateOccurrence(
          userId,
          billSetupId,
          occurrenceId,
          patch,
          tx,
        );
        if (!after) throw new ConflictError("Bill occurrence cannot be edited");
        await occurrences.updateLinkedForecastEvent(
          userId,
          occurrenceId,
          dueDate,
          amountCents,
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_occurrence",
            entityId: occurrenceId,
            action: "update",
            source: "bills.override_occurrence",
            before,
            after,
          },
          tx,
        );
        return toBillOccurrenceDto(after, await linkedFor(userId, [after], tx));
      });
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
      if (!billDispatcher) throw new ServiceUnavailableError();
      await billDispatcher.detect(userId);
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
    const all = await repository.list(userId, ["active"], tx);
    const candidates = all.filter(
      (row) => (!billId || row.id === billId) && row.userConfirmed,
    );
    const today = (dependencies.now?.() ?? new Date())
      .toISOString()
      .slice(0, 10);
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
        bill.cadence === "irregular"
      )
        continue;
      const cadence = bill.cadence as Exclude<
        RecurringCadence,
        "semimonthly" | "irregular"
      >;
      let cursor = bill.nextExpectedDate;
      const dates: string[] = [];
      while (cursor < today) {
        if (cadence === "monthly" && cursor.slice(0, 7) === today.slice(0, 7)) {
          const existing = await occurrences.listBySetup(userId, bill.id, tx);
          if (
            existing.some(
              (row) => row.occurrenceKey === `${bill.id}:${cursor.slice(0, 7)}`,
            )
          ) {
            dates.push(cursor);
          }
        }
        cursor = nextDateForCadence(cursor, cadence);
      }
      while (Date.parse(`${cursor}T00:00:00Z`) <= horizon.getTime()) {
        dates.push(cursor);
        cursor = nextDateForCadence(cursor, cadence);
      }
      if (!dates.length) continue;
      setupsMaterialized += 1;
      occurrencesCreated += dates.length;
      const materialized = await occurrences.insertOccurrences(
        dates.map((dueDate) => ({
          userId,
          billSetupId: bill.id,
          occurrenceKey: `${bill.id}:${cadence === "monthly" ? dueDate.slice(0, 7) : dueDate}`,
          dueDate,
          expectedAmountCents: bill.avgAmount,
        })),
        tx,
      );
      await repository.upsertBillForecastEvents(
        materialized
          .filter((occurrence) =>
            ["upcoming", "overdue", "processing"].includes(occurrence.status),
          )
          .map((occurrence) => ({
            userId,
            accountId: bill.accountId,
            name: bill.canonicalName,
            amountCents:
              occurrence.expectedAmountOverrideCents ??
              occurrence.expectedAmountCents,
            date: occurrence.dueDateOverride ?? occurrence.dueDate,
            categoryId: bill.categoryId,
            recurringSeriesId: bill.id,
            billOccurrenceId: occurrence.id,
          })),
        tx,
      );
    }
    return { setupsMaterialized, occurrencesCreated };
  });
}

/** Worker-facing overdue transition; all writes remain tenant-scoped and transactional. */
export async function runOverdueSweep(
  userId: string,
  dependencies: BillsServiceDependencies = {},
): Promise<void> {
  const occurrences = dependencies.occurrences ?? billOccurrencesRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const mutate =
    dependencies.withUserMutation ??
    ((id, callback) => mutation(cache)(id, callback));
  const workerLogger = dependencies.workerLogger ?? runtimeLogger;
  await mutate(userId, async (tx) => {
    const count = await occurrences.sweepOverdue(userId, tx);
    workerLogger.debug({ userId, count }, "bill overdue sweep complete");
    return undefined;
  });
}

const resolveMaturedForecastEventsInMutation = async (
  userId: string,
  tx: DbTransaction,
  repository: BillsRepository,
  occurrences: BillOccurrencesRepository,
): Promise<void> => {
  const eligibleOccurrences = await occurrences.listAutoConfirmationCandidates(
    userId,
    tx,
  );
  if (eligibleOccurrences.length) {
    const occurrenceDates = eligibleOccurrences.map(
      (row) => row.dueDateOverride ?? row.dueDate,
    );
    const dateFrom = dateOffset(
      occurrenceDates.reduce((a, b) => (a < b ? a : b)),
      -7,
    );
    const dateTo = dateOffset(
      occurrenceDates.reduce((a, b) => (a > b ? a : b)),
      7,
    );
    const candidates = await repository.listAutoConfirmationTransactions(
      userId,
      dateFrom,
      dateTo,
      tx,
    );
    const occurrenceMatches = new Map<string, typeof candidates>();
    const transactionMatches = new Map<string, typeof eligibleOccurrences>();
    for (const occurrence of eligibleOccurrences) {
      const effectiveAmount =
        occurrence.expectedAmountOverrideCents ??
        occurrence.expectedAmountCents;
      const effectiveDate = occurrence.dueDateOverride ?? occurrence.dueDate;
      const matching = candidates.filter((transaction) => {
        if (transaction.amount <= 0n || transaction.amount !== effectiveAmount)
          return false;
        const delta = Math.abs(
          Date.parse(`${transaction.date}T00:00:00Z`) -
            Date.parse(`${effectiveDate}T00:00:00Z`),
        );
        return delta <= 7 * 86_400_000;
      });
      occurrenceMatches.set(occurrence.id, matching);
      for (const transaction of matching) {
        const reverse = transactionMatches.get(transaction.id) ?? [];
        reverse.push(occurrence);
        transactionMatches.set(transaction.id, reverse);
      }
    }
    for (const occurrence of eligibleOccurrences) {
      const matching = occurrenceMatches.get(occurrence.id) ?? [];
      if (matching.length !== 1) continue;
      const transaction = matching[0]!;
      if ((transactionMatches.get(transaction.id) ?? []).length !== 1) continue;
      const claimed = await repository.tryClaimAutoConfirmationTransaction(
        userId,
        transaction.id,
        tx,
      );
      if (!claimed) continue;
      const updated = await occurrences.updateIfStatus(
        userId,
        occurrence.id,
        ["upcoming", "overdue", "processing"],
        {
          status: "paid",
          linkedTransactionId: transaction.id,
          paidAccountId: transaction.accountId,
          paidAmountCents: transaction.amount,
          confirmedPaidAt: new Date(),
        },
        tx,
      );
      if (!updated) continue;
      await repository.resolveBillForecastEvent(
        userId,
        occurrence.id,
        transaction.id,
        tx,
      );
      await repository.recordAudit(
        {
          userId,
          entityType: "bill_occurrence",
          entityId: occurrence.id,
          action: "update",
          source: "bills.auto_confirm_paid",
          before: occurrence,
          after: updated,
        },
        tx,
      );
    }
  }

  const recent = await repository.listRecentRecurringTransactions(userId, tx);
  if (!recent.length) return;
  const seriesIds = [
    ...new Set(
      recent.flatMap((transaction) =>
        transaction.recurringSeriesId ? [transaction.recurringSeriesId] : [],
      ),
    ),
  ];
  const events = await repository.listOpenForecastEvents(userId, seriesIds, tx);
  const usedTransactions = new Set<string>();
  for (const event of events) {
    const matching = recent.find((transaction) => {
      if (usedTransactions.has(transaction.id)) return false;
      if (transaction.recurringSeriesId !== event.recurringSeriesId)
        return false;
      if (
        Math.abs(
          Date.parse(`${transaction.date}T00:00:00Z`) -
            Date.parse(`${event.date}T00:00:00Z`),
        ) >
        7 * 86_400_000
      )
        return false;
      const eventAmount = event.amount;
      if (eventAmount === 0n) return false;
      return abs(transaction.amount - eventAmount) * 5n <= abs(eventAmount);
    });
    if (!matching || !event.recurringSeriesId) continue;
    usedTransactions.add(matching.id);
    await repository.resolveForecastEvent(userId, event.id, matching.id, tx);
  }
};

/** Worker-facing forecast reconciliation; all reads and writes carry the tenant id. */
export async function resolveMaturedForecastEvents(
  userId: string,
  dependencies: BillsServiceDependencies = {},
): Promise<void> {
  const repository = dependencies.repository ?? billsRepository;
  const occurrences = dependencies.occurrences ?? billOccurrencesRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const mutate =
    dependencies.withUserMutation ??
    ((id, callback) => mutation(cache)(id, callback));
  await mutate(userId, async (tx) => {
    await resolveMaturedForecastEventsInMutation(
      userId,
      tx,
      repository,
      occurrences,
    );
    return undefined;
  });
}

export type BillWorkerLifecycle = Readonly<{
  detect: (userId: string) => Promise<{ created: number; updated: number }>;
  materialize: (
    userId: string,
    billId?: string,
    horizonMonths?: number,
  ) => Promise<{ setupsMaterialized: number; occurrencesCreated: number }>;
  upsertStatementBills: (
    userId: string,
  ) => Promise<{ created: number; updated: number }>;
  sweepOverdue: (userId: string) => Promise<void>;
  resolveMaturedForecastEvents: (userId: string) => Promise<void>;
}>;

const abs = (value: bigint) => (value < 0n ? -value : value);
const dateOffset = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
};

/** Public worker boundary; workers import this port from the bills module rather than bill internals. */
export function createBillWorkerLifecycle(
  dependencies: BillsServiceDependencies = {},
): BillWorkerLifecycle {
  return {
    detect: (userId) => runBillDetection(userId, dependencies),
    materialize: (userId, billId, horizonMonths) =>
      materializeBillsForUser(userId, billId, horizonMonths, dependencies),
    upsertStatementBills:
      dependencies.statementBills ?? ((id) => upsertStatementBills(id)),
    sweepOverdue: (userId) => runOverdueSweep(userId, dependencies),
    resolveMaturedForecastEvents: (userId) =>
      resolveMaturedForecastEvents(userId, dependencies),
  };
}
