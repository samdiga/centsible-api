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
  type BillPaymentCandidate,
  type BillRow,
  type BillsRepository,
} from "./bills.repository.js";
import {
  detectRecurring,
  splitSeriesSlot,
  normalizeMerchant,
  addDays,
  nextDateForCadence,
  type ScheduledCadence,
} from "./recurring-engine.js";
import {
  nonCollidingScheduleDates,
  retiredSchedulePrefix,
  safeScheduleDates,
  scheduleKey,
} from "./bill-schedule.js";
import {
  billPaymentMismatch,
  daysApartMs,
  merchantMatchesBill,
  pairClosest,
  type MatchCandidate,
} from "./merchant-match.js";
import { inferPaidFromInMutation } from "./paid-from-inference.js";
import { upsertStatementBills } from "./statement-bills.js";
import type {
  BillDto,
  BillOccurrenceDto,
  CreateBillInput,
  MarkBillPaidInput,
  LinkBillOccurrenceInput,
  BillLinkCandidateDto,
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
  /** Clears the matched payment and stops auto-match re-linking it. */
  unlinkOccurrence: (
    userId: string,
    billSetupId: string,
    occurrenceId: string,
  ) => Promise<BillOccurrenceDto>;
  /** Pays the occurrence with a transaction the user picked. */
  linkOccurrence: (
    userId: string,
    billSetupId: string,
    occurrenceId: string,
    input: LinkBillOccurrenceInput,
  ) => Promise<BillOccurrenceDto>;
  /** Nearby payments the user can pick, most likely first. */
  listLinkCandidates: (
    userId: string,
    billSetupId: string,
    occurrenceId: string,
  ) => Promise<BillLinkCandidateDto[]>;
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
  const today = () =>
    (dependencies.now?.() ?? new Date()).toISOString().slice(0, 10);
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
   * no materialized occurrences (irregular, not yet materialized).
   * `monthOccurrences` carries every occurrence due that month, so a bill paid
   * two or three times a month (biweekly, semi-monthly, weekly) isn't shown once.
   */
  /** Summaries for the occurrences' linked and pending transactions, in one query. */
  const linkedFor = async (
    userId: string,
    rows: ReadonlyArray<BillOccurrenceRow | null | undefined>,
    tx?: DbTransaction,
  ): Promise<ReadonlyMap<string, LinkedTransactionSummary>> => {
    const ids = rows.flatMap((row) => [
      ...(row?.linkedTransactionId ? [row.linkedTransactionId] : []),
      ...(row?.pendingTransactionId ? [row.pendingTransactionId] : []),
    ]);
    if (ids.length === 0) return new Map();
    return occurrences.linkedTransactionSummaries(userId, ids, tx);
  };

  const listMonth = async (userId: string, month: string) => {
    const monthStart = `${month}-01`;
    const lastDay = monthEnd(month);
    const rows = await repository.list(userId, ["active"]);
    const ids = rows.map((row) => row.id);
    const [inMonth, allInMonth, materialized] = await Promise.all([
      occurrences.inRangeForSetups(userId, ids, monthStart, lastDay),
      occurrences.allInRangeForSetups(userId, ids, monthStart, lastDay),
      occurrences.setupIdsWithOccurrences(userId, ids),
    ]);
    const dueIn = (row: BillRow) => {
      const occurrence = inMonth.get(row.id);
      return occurrence
        ? (occurrence.dueDateOverride ?? occurrence.dueDate)
        : row.nextExpectedDate;
    };
    const linked = await linkedFor(userId, [...allInMonth.values()].flat());
    return rows
      .filter((row) => {
        if (inMonth.has(row.id)) return true;
        if (materialized.has(row.id) || !row.nextExpectedDate) return false;
        return (
          row.nextExpectedDate >= monthStart &&
          row.nextExpectedDate <= lastDay &&
          (!row.endDate || row.nextExpectedDate <= row.endDate)
        );
      })
      .sort((a, b) => (dueIn(a) ?? "").localeCompare(dueIn(b) ?? ""))
      .map((row) =>
        toBillDto(
          row,
          inMonth.get(row.id) ?? null,
          linked,
          allInMonth.get(row.id) ?? [],
        ),
      );
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
            avgAmount: input.isIncome ? -input.amountCents : input.amountCents,
            nextExpectedDate: input.nextExpectedDate,
            endDate: input.endDate ?? null,
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
        const before = await repository.findById(userId, id, tx, true);
        if (!before) throw new NotFoundError("bill");
        const { amountCents, cadence, ...patch } = input;
        const external =
          input.paidFromExternal ?? before.paidFromExternal ?? false;
        const sourceAccount =
          input.accountId === undefined ? before.accountId : input.accountId;
        if (external && sourceAccount)
          throw new ValidationError(
            "An external payment source cannot also have an account in Centsy",
          );
        const changesSchedule =
          amountCents !== undefined ||
          cadence !== undefined ||
          input.nextExpectedDate !== undefined;
        const rescheduleActive =
          changesSchedule && before.status === "active" && before.userConfirmed;
        if (
          changesSchedule &&
          !rescheduleActive &&
          (before.status !== "pending_confirmation" || before.userConfirmed)
        )
          throw new ValidationError(
            "Edit an active bill or correct its estimate before confirming",
          );
        if (
          rescheduleActive &&
          before.billType === "transfer" &&
          before.toAccountId
        ) {
          const destination = await repository.findTransferAccount(
            userId,
            before.toAccountId,
            tx,
          );
          if (destination?.type === "credit")
            throw new ValidationError(
              "Card statement amounts and dates come from your bank",
            );
        }
        if (
          rescheduleActive &&
          input.nextExpectedDate &&
          input.nextExpectedDate <
            (dependencies.now?.() ?? new Date()).toISOString().slice(0, 10)
        )
          throw new ValidationError(
            "Next expected date must be today or later",
          );
        const effectiveCadence =
          cadence === undefined
            ? (before.cadenceOverride ?? before.cadence)
            : (cadence ?? before.cadence);
        if (rescheduleActive && effectiveCadence === "irregular")
          throw new ValidationError(
            "Choose a supported cadence when changing this schedule",
          );
        const nextType = input.billType ?? before.billType;
        const nextAccount =
          input.toAccountId === undefined
            ? before.toAccountId
            : input.toAccountId;
        if (
          rescheduleActive &&
          nextType === "transfer" &&
          nextAccount &&
          nextAccount !== before.toAccountId
        ) {
          const destination = await repository.findTransferAccount(
            userId,
            nextAccount,
            tx,
          );
          if (destination?.type === "credit")
            throw new ValidationError(
              "Card statement amounts and dates come from your bank",
            );
        }
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
        const row = await repository.update(
          userId,
          id,
          {
            ...patch,
            ...(amountCents !== undefined
              ? { avgAmount: before.isIncome ? -amountCents : amountCents }
              : {}),
            ...(cadence !== undefined ? { cadenceOverride: cadence } : {}),
          },
          tx,
        );
        if (!row) throw new NotFoundError("bill");
        if (
          (input.endDate !== undefined || input.status === "active") &&
          row.status === "active" &&
          row.endDate !== undefined
        )
          await occurrences.reconcileEndDate(
            userId,
            id,
            row.endDate,
            (dependencies.now?.() ?? new Date()).toISOString().slice(0, 10),
            tx,
          );
        if (row.status === "active" && row.userConfirmed && !billDispatcher)
          throw new ServiceUnavailableError();
        if (rescheduleActive && row.status === "active" && row.userConfirmed)
          await materializeBillsInMutation(
            userId,
            id,
            12,
            { ...dependencies, repository, occurrences },
            tx,
            row,
            true,
          );
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

        if (input.paymentOverrideCents !== undefined) {
          const setup = await repository.findById(userId, billSetupId, tx);
          const card =
            setup?.billType === "transfer" && setup.toAccountId
              ? await repository.findTransferAccount(
                  userId,
                  setup.toAccountId,
                  tx,
                )
              : null;
          if (
            !setup?.userConfirmed ||
            card?.type !== "credit" ||
            !card.statementBalance ||
            !card.paymentDueDate
          )
            throw new ValidationError(
              "Payment overrides apply only to card statement occurrences",
            );
          // This setting is for the v2 engine. Do not mutate v1 expected amounts or forecasts.
        }

        // Omitted keeps the current value; null clears the override so the
        // scheduled baseline applies again.
        const currentDate = before.dueDateOverride ?? before.dueDate;
        const dueDate =
          input.dueDate === undefined
            ? currentDate
            : (input.dueDate ?? before.dueDate);
        if (before.setupEndDate && dueDate > before.setupEndDate)
          throw new ValidationError(
            "Occurrence date is after the bill end date",
          );
        const signedOverride =
          input.amountCents == null
            ? input.amountCents
            : before.expectedAmountCents < 0n
              ? -input.amountCents
              : input.amountCents;
        const amountCents =
          signedOverride === undefined
            ? (before.expectedAmountOverrideCents ?? before.expectedAmountCents)
            : (signedOverride ?? before.expectedAmountCents);
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
          ...(input.paymentOverrideCents === undefined
            ? {}
            : { paymentOverrideCents: input.paymentOverrideCents }),
          ...(signedOverride === undefined
            ? {}
            : { expectedAmountOverrideCents: signedOverride }),
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
        if (input.amountCents !== undefined || input.dueDate !== undefined)
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
        if (before.expectedAmountCents < 0n)
          throw new ConflictError(
            "Income is confirmed when its deposit arrives",
          );
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
    async unlinkOccurrence(userId, billSetupId, occurrenceId) {
      return mutate(userId, async (tx) => {
        const before = await occurrences.findEditableOccurrence(
          userId,
          billSetupId,
          occurrenceId,
          tx,
        );
        if (!before) throw new NotFoundError("bill occurrence");
        const transactionId =
          before.linkedTransactionId ?? before.pendingTransactionId;
        if (!transactionId)
          throw new ConflictError("Bill occurrence has no matched payment");
        const after = await occurrences.updateIfStatus(
          userId,
          occurrenceId,
          ["paid", "processing"],
          {
            status: unpaidStatus(before, today()),
            linkedTransactionId: null,
            pendingTransactionId: null,
            paidAccountId: null,
            paidAmountCents: null,
            markedPaidAt: null,
            confirmedPaidAt: null,
          },
          tx,
        );
        if (!after)
          throw new ConflictError("Bill occurrence has no matched payment");
        await repository.rejectMatch(userId, occurrenceId, transactionId, tx);
        await repository.reopenBillForecastEvent(
          userId,
          occurrenceId,
          transactionId,
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_occurrence",
            entityId: occurrenceId,
            action: "update",
            source: "bills.user_unlink",
            before,
            after,
          },
          tx,
        );
        return toBillOccurrenceDto(after, await linkedFor(userId, [after], tx));
      });
    },
    async linkOccurrence(userId, billSetupId, occurrenceId, input) {
      return mutate(userId, async (tx) => {
        const before = await occurrences.findEditableOccurrence(
          userId,
          billSetupId,
          occurrenceId,
          tx,
        );
        if (!before) throw new NotFoundError("bill occurrence");
        if (before.expectedAmountCents < 0n)
          throw new ConflictError(
            "Income is confirmed when its deposit arrives",
          );
        if (before.status === "skipped" || before.status === "cancelled")
          throw new ConflictError("Bill occurrence cannot be marked paid");
        if (before.linkedTransactionId === input.transactionId)
          return toBillOccurrenceDto(
            before,
            await linkedFor(userId, [before], tx),
          );
        const dueDate = before.dueDateOverride ?? before.dueDate;
        const transaction = (
          await repository.listLinkCandidates(
            userId,
            dateOffset(dueDate, -LINK_WINDOW_DAYS),
            dateOffset(dueDate, LINK_WINDOW_DAYS),
            occurrenceId,
            tx,
          )
        ).find((row) => row.id === input.transactionId);
        if (!transaction)
          throw new ValidationError(
            `transactionId must be a posted payment within ${LINK_WINDOW_DAYS} days of the due date that no other bill uses.`,
          );
        if (
          !(await repository.tryClaimAutoConfirmationTransaction(
            userId,
            transaction.id,
            tx,
            occurrenceId,
          ))
        )
          throw new ConflictError("That payment is matched to another bill");
        const previous =
          before.linkedTransactionId ?? before.pendingTransactionId;
        if (previous) {
          await repository.rejectMatch(userId, occurrenceId, previous, tx);
          await repository.reopenBillForecastEvent(
            userId,
            occurrenceId,
            previous,
            tx,
          );
        }
        const after = await occurrences.updateIfStatus(
          userId,
          occurrenceId,
          ["upcoming", "overdue", "processing", "paid"],
          {
            status: "paid",
            pendingTransactionId: null,
            linkedTransactionId: transaction.id,
            paidAccountId: transaction.accountId,
            paidAmountCents: transaction.amount,
            confirmedPaidAt: new Date(),
          },
          tx,
        );
        if (!after)
          throw new ConflictError("Bill occurrence cannot be marked paid");
        await repository.clearRejection(
          userId,
          occurrenceId,
          transaction.id,
          tx,
        );
        await repository.resolveBillForecastEvent(
          userId,
          occurrenceId,
          transaction.id,
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_occurrence",
            entityId: occurrenceId,
            action: "update",
            source: "bills.user_link",
            before,
            after,
          },
          tx,
        );
        const setup = await repository.findById(userId, billSetupId, tx);
        if (setup) {
          await applyBillCategory(
            repository,
            userId,
            setup,
            after,
            transaction.id,
            tx,
          );
          // The user chose this payment: its bank name is the bill's.
          await learnMerchantPattern(
            repository,
            userId,
            setup,
            transaction,
            tx,
          );
        }
        return toBillOccurrenceDto(after, await linkedFor(userId, [after], tx));
      });
    },
    async listLinkCandidates(userId, billSetupId, occurrenceId) {
      const occurrence = await occurrences.findById(userId, occurrenceId);
      if (!occurrence || occurrence.billSetupId !== billSetupId)
        throw new NotFoundError("bill occurrence");
      const setup = await repository.findById(userId, billSetupId);
      if (!setup) throw new NotFoundError("bill");
      const dueDate = occurrence.dueDateOverride ?? occurrence.dueDate;
      const amount =
        occurrence.expectedAmountOverrideCents ??
        occurrence.expectedAmountCents;
      const payeeNames =
        setup.billType === "transfer" && setup.toAccountId
          ? ((
              await repository.listAccountPayeeNames(userId, [
                setup.toAccountId,
              ])
            ).get(setup.toAccountId) ?? [])
          : [];
      const billNames = [
        setup.canonicalName,
        setup.displayName,
        ...setup.merchantPatterns,
        ...payeeNames,
      ];
      const current = occurrence.linkedTransactionId;
      return (
        await repository.listLinkCandidates(
          userId,
          dateOffset(dueDate, -LINK_WINDOW_DAYS),
          dateOffset(dueDate, LINK_WINDOW_DAYS),
          occurrenceId,
        )
      )
        .map((row) => ({
          row,
          sameAmount: row.amount === amount,
          merchantMatch: merchantMatchesBill(billNames, [
            row.merchantName,
            row.name,
          ]),
          distance: daysApartMs(row.date, dueDate),
        }))
        .sort(
          (a, b) =>
            Number(b.sameAmount) - Number(a.sameAmount) ||
            Number(b.merchantMatch) - Number(a.merchantMatch) ||
            a.distance - b.distance ||
            a.row.id.localeCompare(b.row.id),
        )
        .slice(0, MAX_LINK_CANDIDATES)
        .map(({ row, sameAmount, merchantMatch }) => ({
          id: row.id,
          name: row.merchantName?.trim() || row.name,
          accountName: row.accountName,
          date: row.date,
          amountCents: row.amount.toString(),
          sameAmount,
          merchantMatch,
          isCurrent: row.id === current,
        }));
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
      cadenceOverride: row.cadenceOverride,
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
    await inferPaidFromInMutation(
      userId,
      tx,
      dependencies.now?.().toISOString().slice(0, 10),
    );
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
  return mutate(userId, (tx) =>
    materializeBillsInMutation(
      userId,
      billId,
      horizonMonths,
      { ...dependencies, repository, occurrences },
      tx,
    ),
  );
}

async function materializeBillsInMutation(
  userId: string,
  billId: string | undefined,
  horizonMonths: number,
  dependencies: BillsServiceDependencies,
  tx: DbTransaction,
  onlyBill?: BillRow,
  reschedule = false,
): Promise<{ setupsMaterialized: number; occurrencesCreated: number }> {
  const repository = dependencies.repository ?? billsRepository;
  const occurrences = dependencies.occurrences ?? billOccurrencesRepository;
  const all = onlyBill
    ? [onlyBill]
    : await repository.list(userId, ["active"], tx, true);
  const candidates = all.filter(
    (row) => (!billId || row.id === billId) && row.userConfirmed,
  );
  const today = (dependencies.now?.() ?? new Date()).toISOString().slice(0, 10);
  const [year, month, day] = today.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const horizon = new Date(Date.UTC(year, month - 1 + horizonMonths, day));
  let setupsMaterialized = 0;
  let occurrencesCreated = 0;
  for (const candidate of candidates) {
    const bill = {
      ...candidate,
      cadence: candidate.cadenceOverride ?? candidate.cadence,
    };
    const transferAccount =
      bill.billType === "transfer" && bill.toAccountId
        ? await repository.findTransferAccount(userId, bill.toAccountId, tx)
        : undefined;
    if (transferAccount === null) continue;
    const cardStatement =
      transferAccount?.type === "credit" ? transferAccount : undefined;
    if (
      cardStatement &&
      (!cardStatement.statementDate ||
        !cardStatement.paymentDueDate ||
        cardStatement.statementBalance === null ||
        cardStatement.statementBalance <= 0n)
    )
      continue;
    if (!bill.nextExpectedDate || bill.cadence === "irregular") continue;
    const cadence = bill.cadence as ScheduledCadence;
    // A semi-monthly schedule starts on the first pay date on or after the
    // stored next date, which may predate a switch from another cadence.
    let cursor =
      cadence === "semimonthly"
        ? nextDateForCadence(addDays(bill.nextExpectedDate, -1), cadence)
        : bill.nextExpectedDate;
    const dates: string[] = [];
    if (cardStatement) {
      // An issued card statement is one obligation, never a recurring estimate.
      dates.push(cardStatement.paymentDueDate!);
    } else {
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
    }
    let allowedDates = dates.filter(
      (date) => !bill.endDate || date <= bill.endDate,
    );
    const scheduled = await occurrences.listBySetup(userId, bill.id, tx);
    // Detection re-anchors a date-keyed schedule on the latest payment, so a
    // payment a day late (a bank holiday) moves every future date. Untouched
    // future occurrences off the new schedule are then the old cadence's and
    // must be replaced, not kept alongside it. Monthly keys follow the move.
    const phaseMoved =
      cadence !== "monthly" &&
      !cardStatement &&
      scheduled.some(
        (row) =>
          row.status === "upcoming" &&
          row.dueDate >= today &&
          row.dueDateOverride === null &&
          row.expectedAmountOverrideCents === null &&
          row.linkedTransactionId === null &&
          row.markedPaidAt === null &&
          !dates.includes(row.dueDate),
      );
    const realign =
      reschedule ||
      phaseMoved ||
      scheduled.some((row) =>
        row.occurrenceKey.startsWith(retiredSchedulePrefix(bill.id)),
      );
    if (realign) {
      await occurrences.retireFutureSchedule(userId, bill.id, today, tx);
      const existing = await occurrences.listBySetup(userId, bill.id, tx);
      allowedDates = safeScheduleDates(
        bill.id,
        cadence,
        today,
        allowedDates.filter((date) => date >= today),
        existing,
      );
      for (const date of allowedDates.filter((date) =>
        existing.some(
          (row) =>
            row.dueDate === date &&
            row.occurrenceKey.startsWith(retiredSchedulePrefix(bill.id)),
        ),
      )) {
        await occurrences.adoptRetiredScheduleDate(
          userId,
          bill.id,
          date,
          scheduleKey(bill.id, cadence, date),
          bill.avgAmount,
          tx,
        );
      }
    }
    if (!realign)
      allowedDates = nonCollidingScheduleDates(
        bill.id,
        cadence,
        allowedDates,
        scheduled,
      );
    if (!allowedDates.length) continue;
    setupsMaterialized += 1;
    occurrencesCreated += allowedDates.length;
    const materialized = await occurrences.insertOccurrences(
      allowedDates.map((dueDate) => ({
        userId,
        billSetupId: bill.id,
        occurrenceKey: `${bill.id}:${cadence === "monthly" ? dueDate.slice(0, 7) : dueDate}`,
        dueDate,
        expectedAmountCents: cardStatement?.statementBalance ?? bill.avgAmount,
      })),
      tx,
    );
    await repository.upsertBillForecastEvents(
      materialized
        .filter(
          (occurrence) =>
            ["upcoming", "overdue", "processing"].includes(occurrence.status) &&
            (!bill.endDate ||
              (occurrence.dueDateOverride ?? occurrence.dueDate) <=
                bill.endDate),
        )
        .map((occurrence) => ({
          userId,
          accountId: bill.accountId,
          name: bill.displayName ?? bill.canonicalName,
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

/** Learned bank spellings kept per bill; enough for a few descriptor variants. */
const MAX_MERCHANT_PATTERNS = 20;
/** How far from the due date a user may pick the payment. */
const LINK_WINDOW_DAYS = 31;
const MAX_LINK_CANDIDATES = 50;

/** Back to waiting: overdue once its due date has come. */
const unpaidStatus = (occurrence: BillOccurrenceRow, today: string) =>
  (occurrence.dueDateOverride ?? occurrence.dueDate) <= today
    ? ("overdue" as const)
    : ("upcoming" as const);

/** Gives a payment the bill's category, unless the user picked one by hand. */
const applyBillCategory = async (
  repository: BillsRepository,
  userId: string,
  setup: BillRow,
  occurrence: BillOccurrenceRow,
  transactionId: string,
  tx: DbTransaction,
) => {
  if (
    setup.categoryId &&
    (await repository.applyBillCategoryToTransaction(
      userId,
      transactionId,
      setup.categoryId,
      tx,
    ))
  )
    await repository.recordAudit(
      {
        userId,
        entityType: "transaction",
        entityId: transactionId,
        action: "update",
        source: "bills.apply_category",
        before: { billOccurrenceId: occurrence.id },
        after: { categoryId: setup.categoryId },
      },
      tx,
    );
};

/** Remembers the bank's spelling so later payments match on it too. */
const learnMerchantPattern = async (
  repository: BillsRepository,
  userId: string,
  setup: BillRow,
  transaction: Pick<BillPaymentCandidate, "merchantName" | "name">,
  tx: DbTransaction,
) => {
  const learned = normalizeMerchant(
    transaction.merchantName ?? transaction.name,
  );
  if (
    !learned ||
    setup.merchantPatterns.includes(learned) ||
    setup.merchantPatterns.length >= MAX_MERCHANT_PATTERNS
  )
    return;
  const merchantPatterns = [...setup.merchantPatterns, learned];
  await repository.update(userId, setup.id, { merchantPatterns }, tx);
  await repository.recordAudit(
    {
      userId,
      entityType: "bill_setup",
      entityId: setup.id,
      action: "update",
      source: "bills.learn_merchant",
      before: { merchantPatterns: setup.merchantPatterns },
      after: { merchantPatterns },
    },
    tx,
  );
};

const resolveMaturedForecastEventsInMutation = async (
  userId: string,
  tx: DbTransaction,
  repository: BillsRepository,
  occurrences: BillOccurrencesRepository,
): Promise<void> => {
  const confirmPaid = async (
    occurrence: BillOccurrenceRow,
    transaction: Pick<
      BillPaymentCandidate,
      "id" | "accountId" | "amount" | "merchantName" | "name"
    >,
    excludeOwnPendingLink = false,
    /** Who paid, when the linked transaction is the card receiving it. */
    paidAccountId: string | null = transaction.accountId,
  ): Promise<boolean> => {
    const claimed = excludeOwnPendingLink
      ? await repository.tryClaimAutoConfirmationTransaction(
          userId,
          transaction.id,
          tx,
          occurrence.id,
        )
      : await repository.tryClaimAutoConfirmationTransaction(
          userId,
          transaction.id,
          tx,
        );
    if (!claimed) return false;
    const updated = await occurrences.updateIfStatus(
      userId,
      occurrence.id,
      ["upcoming", "overdue", "processing"],
      {
        status: "paid",
        pendingTransactionId: null,
        linkedTransactionId: transaction.id,
        paidAccountId,
        paidAmountCents: transaction.amount,
        confirmedPaidAt: new Date(),
      },
      tx,
    );
    if (!updated) return false;
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
    const setup = await repository.findById(userId, occurrence.billSetupId, tx);
    if (!setup) return true;
    await applyBillCategory(
      repository,
      userId,
      setup,
      occurrence,
      transaction.id,
      tx,
    );
    // A pending link made before the merchant rule may settle here; never
    // learn a payee the bill's names do not already point to.
    if (
      occurrence.expectedAmountCents > 0n &&
      merchantMatchesBill(
        [setup.canonicalName, setup.displayName, ...setup.merchantPatterns],
        [transaction.merchantName, transaction.name],
      )
    )
      await learnMerchantPattern(repository, userId, setup, transaction, tx);
    return true;
  };

  let eligibleOccurrences = await occurrences.listAutoConfirmationCandidates(
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
    const hasIncome = eligibleOccurrences.some(
      (row) => row.expectedAmountCents < 0n,
    );
    const setups = await repository.list(
      userId,
      ["active", "paused", "ended", "pending_confirmation"],
      tx,
    );
    const incomeSetups = setups.filter((row) => row.status === "active");
    const incomeCandidates = hasIncome
      ? await repository.listIncomeConfirmationTransactions(
          userId,
          dateFrom,
          dateTo,
          tx,
        )
      : [];
    const allCandidates = [...candidates, ...incomeCandidates];
    const settledIds = new Set<string>();
    const pendingLinks = eligibleOccurrences.filter(
      (row) => row.status === "processing" && row.pendingTransactionId,
    );
    if (pendingLinks.length) {
      const states =
        (await repository.listPendingLinkStates?.(
          userId,
          pendingLinks.map((row) => row.pendingTransactionId!),
          tx,
        )) ?? [];
      const byId = new Map(states.map((state) => [state.id, state]));
      const replacements =
        (await repository.listPostedReplacements?.(
          userId,
          states.flatMap((state) =>
            state.plaidTransactionId ? [state.plaidTransactionId] : [],
          ),
          tx,
        )) ?? [];
      for (const occurrence of pendingLinks) {
        const pending = byId.get(occurrence.pendingTransactionId!);
        const posted = [
          ...(pending?.status === "posted" && !pending.deletedAt
            ? [pending]
            : []),
          ...replacements.filter(
            (candidate) =>
              candidate.pendingPlaidTransactionId ===
                pending?.plaidTransactionId &&
              candidate.accountId === pending?.accountId,
          ),
        ];
        // A card payment held from the card's side records the bill's
        // paying account, not the card.
        const setup = setups.find((row) => row.id === occurrence.billSetupId);
        const fromCard =
          setup?.billType === "transfer" &&
          !!setup.toAccountId &&
          setup.toAccountId === posted[0]?.accountId;
        const payer = fromCard
          ? setup.paidFromExternal
            ? null
            : (setup.accountId ?? null)
          : posted[0]?.accountId;
        // The card stores a payment received as negative; the bill paid a
        // positive amount.
        const payment =
          fromCard && posted[0]!.amount < 0n
            ? { ...posted[0]!, amount: -posted[0]!.amount }
            : posted[0];
        if (
          posted.length === 1 &&
          (await confirmPaid(occurrence, payment!, true, payer ?? null))
        ) {
          settledIds.add(occurrence.id);
          continue;
        }
        if (
          posted.length > 0 ||
          (pending?.status === "pending" && !pending.deletedAt)
        )
          continue;
        const effectiveDate = occurrence.dueDateOverride ?? occurrence.dueDate;
        const restored = await occurrences.updateIfStatus(
          userId,
          occurrence.id,
          ["processing"],
          {
            status:
              effectiveDate <= new Date().toISOString().slice(0, 10)
                ? "overdue"
                : "upcoming",
            pendingTransactionId: null,
          },
          tx,
        );
        if (!restored) continue;
        eligibleOccurrences = eligibleOccurrences.map((row) =>
          row.id === occurrence.id ? restored : row,
        );
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_occurrence",
            entityId: occurrence.id,
            action: "update",
            source: "bills.pending_reverted",
            before: occurrence,
            after: restored,
          },
          tx,
        );
      }
    }
    eligibleOccurrences = eligibleOccurrences.filter(
      (row) => !settledIds.has(row.id),
    );
    // A card or loan payment reads as the lender ("CHASE CREDIT CRD"), not
    // as the bill's name, so a transfer bill also answers to its To account,
    // and to the payment showing up on that account.
    const toAccountIds = [
      ...new Set(
        setups.flatMap((row) =>
          row.billType === "transfer" && row.toAccountId
            ? [row.toAccountId]
            : [],
        ),
      ),
    ];
    const payeeNames =
      (await repository.listAccountPayeeNames?.(userId, toAccountIds, tx)) ??
      new Map<string, string[]>();
    const inflows =
      (await repository.listAccountInflows?.(
        userId,
        toAccountIds,
        dateOffset(dateFrom, -5),
        dateOffset(dateTo, 5),
        tx,
      )) ?? [];
    const setupById = new Map(
      setups.map((row) => [
        row.id,
        {
          ...row,
          payeeNames: row.toAccountId
            ? payeeNames.get(row.toAccountId)
            : undefined,
          toAccountInflows: inflows.filter(
            (inflow) => inflow.accountId === row.toAccountId,
          ),
        },
      ]),
    );
    const expenseMismatch = (
      occurrence: BillOccurrenceRow,
      payment: BillPaymentCandidate,
    ) => {
      const setup = setupById.get(occurrence.billSetupId);
      return setup
        ? billPaymentMismatch(
            setup,
            {
              amount:
                occurrence.expectedAmountOverrideCents ??
                occurrence.expectedAmountCents,
              date: occurrence.dueDateOverride ?? occurrence.dueDate,
            },
            payment,
          )
        : "merchant";
    };
    // Pairs the user unmatched never come back on their own.
    const rejected =
      (await repository.listRejectedPairs?.(
        userId,
        eligibleOccurrences.map((row) => row.id),
        tx,
      )) ?? new Set<string>();
    const allowed = (candidate: MatchCandidate) =>
      !rejected.has(`${candidate.occurrenceId}:${candidate.transactionId}`);
    const qualifying: MatchCandidate[] = [];
    for (const occurrence of eligibleOccurrences) {
      const effectiveAmount =
        occurrence.expectedAmountOverrideCents ??
        occurrence.expectedAmountCents;
      const effectiveDate = occurrence.dueDateOverride ?? occurrence.dueDate;
      if (effectiveAmount < 0n) {
        const setup = incomeSetups.find(
          (row) =>
            row.id === occurrence.billSetupId &&
            row.isIncome &&
            row.userConfirmed,
        );
        if (!setup) continue;
        for (const deposit of incomeCandidates) {
          const distanceMs = daysApartMs(deposit.date, effectiveDate);
          if (
            distanceMs > 7 * 86_400_000 ||
            (setup.accountId && setup.accountId !== deposit.accountId) ||
            normalizeMerchant(setup.canonicalName) !==
              normalizeMerchant(deposit.merchantName ?? deposit.name)
          )
            continue;
          qualifying.push({
            occurrenceId: occurrence.id,
            transactionId: deposit.id,
            distanceMs,
          });
        }
        continue;
      }
      for (const payment of candidates)
        if (!expenseMismatch(occurrence, payment))
          qualifying.push({
            occurrenceId: occurrence.id,
            transactionId: payment.id,
            distanceMs: daysApartMs(payment.date, effectiveDate),
          });
    }
    // Slot bills of one split series due the same day take interchangeable
    // payments ("Fidelity $50 (1 of 2)" and "(2 of 2)").
    const slotsOf = (rows: BillOccurrenceRow[]) =>
      new Map(
        rows.flatMap((row) => {
          const setup = setupById.get(row.billSetupId);
          const slot = setup && splitSeriesSlot(setup.canonicalName);
          return slot
            ? [
                [
                  row.id,
                  {
                    groupId: `${slot.base}|${row.dueDateOverride ?? row.dueDate}`,
                    slot: slot.slot,
                  },
                ] as const,
              ]
            : [];
        }),
      );
    const paired = pairClosest(
      qualifying.filter(allowed),
      slotsOf(eligibleOccurrences),
    );
    const transactionById = new Map(
      allCandidates.map((transaction) => [transaction.id, transaction]),
    );
    for (const occurrence of eligibleOccurrences) {
      const transactionId = paired.get(occurrence.id);
      const transaction = transactionId && transactionById.get(transactionId);
      if (!transaction) continue;
      if (await confirmPaid(occurrence, transaction))
        settledIds.add(occurrence.id);
    }

    // A card or loan payment can settle from the card's side alone: the
    // payment arriving there, for the bill's amount, near its due date. That
    // covers a debit that reads oddly or hasn't posted, and a bill paid from
    // an account Centsy can't see. A matching debit on the paying account
    // was linked above and wins.
    const cardSetupOf = (occurrence: BillOccurrenceRow) => {
      const setup = setupById.get(occurrence.billSetupId);
      return setup?.billType === "transfer" && setup.toAccountId ? setup : null;
    };
    const effectiveOf = (occurrence: BillOccurrenceRow) => ({
      amount:
        occurrence.expectedAmountOverrideCents ??
        occurrence.expectedAmountCents,
      date: occurrence.dueDateOverride ?? occurrence.dueDate,
    });
    const inflowQualifying = (
      awaiting: BillOccurrenceRow[],
      received: BillPaymentCandidate[],
    ) =>
      awaiting.flatMap((occurrence) => {
        const setup = cardSetupOf(occurrence)!;
        const { amount, date } = effectiveOf(occurrence);
        return received
          .filter(
            (inflow) =>
              inflow.accountId === setup.toAccountId &&
              inflow.amount === amount &&
              daysApartMs(inflow.date, date) <= 7 * 86_400_000,
          )
          .map((inflow) => ({
            occurrenceId: occurrence.id,
            transactionId: inflow.id,
            distanceMs: daysApartMs(inflow.date, date),
          }));
      });
    const payerOf = (occurrence: BillOccurrenceRow) => {
      const setup = cardSetupOf(occurrence);
      return setup && !setup.paidFromExternal
        ? (setup.accountId ?? null)
        : null;
    };
    const awaitingCard = eligibleOccurrences.filter(
      (row) =>
        !settledIds.has(row.id) &&
        !row.pendingTransactionId &&
        effectiveOf(row).amount > 0n &&
        cardSetupOf(row),
    );
    const cardIds = [
      ...new Set(awaitingCard.map((row) => cardSetupOf(row)!.toAccountId!)),
    ];
    if (awaitingCard.length) {
      const received =
        (await repository.listCardPaymentInflows?.(
          userId,
          cardIds,
          dateFrom,
          dateTo,
          "posted",
          tx,
        )) ?? [];
      const receivedById = new Map(received.map((row) => [row.id, row]));
      const inflowPaired = pairClosest(
        inflowQualifying(awaitingCard, received).filter(allowed),
        slotsOf(awaitingCard),
      );
      for (const occurrence of awaitingCard) {
        const transactionId = inflowPaired.get(occurrence.id);
        const inflow = transactionId && receivedById.get(transactionId);
        if (!inflow) continue;
        if (await confirmPaid(occurrence, inflow, false, payerOf(occurrence)))
          settledIds.add(occurrence.id);
      }
    }

    const pendingOccurrences = eligibleOccurrences.filter(
      (row) =>
        !settledIds.has(row.id) &&
        (row.status === "upcoming" || row.status === "overdue") &&
        !row.pendingTransactionId &&
        (row.expectedAmountOverrideCents ?? row.expectedAmountCents) > 0n,
    );
    if (pendingOccurrences.length) {
      const pendingCandidates =
        (await repository.listPendingConfirmationTransactions?.(
          userId,
          dateFrom,
          dateTo,
          tx,
        )) ?? [];
      const pendingQualifying: MatchCandidate[] = [];
      for (const occurrence of pendingOccurrences)
        for (const payment of pendingCandidates)
          if (!expenseMismatch(occurrence, payment))
            pendingQualifying.push({
              occurrenceId: occurrence.id,
              transactionId: payment.id,
              distanceMs: daysApartMs(
                payment.date,
                occurrence.dueDateOverride ?? occurrence.dueDate,
              ),
            });
      // A payment still pending on the card holds the bill the same way a
      // pending debit does (T-114), unless a pending debit already qualifies.
      const pendingCard = pendingOccurrences.filter(
        (row) =>
          cardSetupOf(row) &&
          !pendingQualifying.some((pair) => pair.occurrenceId === row.id),
      );
      const pendingInflows = pendingCard.length
        ? ((await repository.listCardPaymentInflows?.(
            userId,
            [
              ...new Set(
                pendingCard.map((row) => cardSetupOf(row)!.toAccountId!),
              ),
            ],
            dateFrom,
            dateTo,
            "pending",
            tx,
          )) ?? [])
        : [];
      pendingCandidates.push(...pendingInflows);
      pendingQualifying.push(...inflowQualifying(pendingCard, pendingInflows));
      const pendingPaired = pairClosest(
        pendingQualifying.filter(allowed),
        slotsOf(pendingOccurrences),
      );
      const pendingById = new Map(
        pendingCandidates.map((transaction) => [transaction.id, transaction]),
      );
      for (const occurrence of pendingOccurrences) {
        const transactionId = pendingPaired.get(occurrence.id);
        const transaction = transactionId && pendingById.get(transactionId);
        if (!transaction) continue;
        const claimed = await repository.tryClaimAutoConfirmationTransaction(
          userId,
          transaction.id,
          tx,
        );
        if (!claimed) continue;
        const updated = await occurrences.updateIfStatus(
          userId,
          occurrence.id,
          ["upcoming", "overdue"],
          { status: "processing", pendingTransactionId: transaction.id },
          tx,
        );
        if (!updated) continue;
        await repository.recordAudit(
          {
            userId,
            entityType: "bill_occurrence",
            entityId: occurrence.id,
            action: "update",
            source: "bills.auto_match_pending",
            before: occurrence,
            after: updated,
          },
          tx,
        );
      }
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
