/* eslint-disable @typescript-eslint/no-explicit-any -- narrow repository doubles intentionally expose only the methods under test. */
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../../platform/errors/app-error.js";
import {
  createBillWorkerLifecycle,
  createBillsService,
  runOverdueSweep,
  resolveMaturedForecastEvents,
} from "../bills.service.js";
import type { BillsRepository } from "../bills.repository.js";
import type { BillOccurrencesRepository } from "../bill-occurrences.repository.js";
import { createUserMutationService } from "../../../platform/cache/user-revisions.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BILL_ID = "22222222-2222-4222-8222-222222222222";
const occurrence = {
  id: "33333333-3333-4333-8333-333333333333",
  userId: USER_ID,
  billSetupId: BILL_ID,
  dueDate: "2026-10-01",
  status: "paid" as const,
  expectedAmountCents: 100n,
  paidAmountCents: null,
  paidAccountId: null,
  linkedTransactionId: null,
  markedPaidAt: null,
  confirmedPaidAt: null,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("bills service", () => {
  it("dispatches materialization after manual create and active update", async () => {
    const created = {
      id: BILL_ID,
      canonicalName: "Rent",
      cadence: "monthly" as const,
      status: "active" as const,
      avgAmount: 145000n,
      lastAmount: null,
      nextExpectedDate: "2026-10-01",
      lastOccurredOn: null,
      categoryId: null,
      billType: "payable" as const,
      accountId: null,
      toAccountId: null,
      confidence: 1,
      sampleCount: 1,
      userConfirmed: true,
      lastPriceChangeAt: null,
      previousAvgAmount: null,
      notes: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      deletedAt: null,
      userId: USER_ID,
      merchantPatterns: [],
      isIncome: false,
      stdDevAmount: 0n,
      dayOfMonth: null,
      dayOfWeek: null,
      autoDetected: false,
    };
    const materialize = vi.fn(async () => undefined);
    const repository = {
      accountExists: vi.fn(async () => true),
      categoryExists: vi.fn(async () => true),
      insertManual: vi.fn(async () => created),
      findById: vi.fn(async () => created),
      update: vi.fn(async () => created),
      recordAudit: vi.fn(async () => undefined),
    } as unknown as BillsRepository;
    const occurrences = {
      cancelFuture: vi.fn(async () => undefined),
    } as unknown as BillOccurrencesRepository;
    const service = createBillsService({
      repository,
      occurrences,
      billDispatcher: {
        detect: vi.fn(async () => undefined),
        materialize,
      },
      withUserMutation: vi.fn(async (_userId, callback) => callback({})),
    });

    await service.createBill(USER_ID, {
      canonicalName: "Rent",
      amountCents: 145000n,
      cadence: "monthly",
      nextExpectedDate: "2026-10-01",
      isIncome: false,
      billType: "payable",
    });
    await service.updateBill(USER_ID, BILL_ID, { userConfirmed: true });

    expect(materialize).toHaveBeenNthCalledWith(1, USER_ID, BILL_ID);
    expect(materialize).toHaveBeenNthCalledWith(2, USER_ID, BILL_ID);
  });

  it("fails create before mutation when bill dispatch is unavailable", async () => {
    const insertManual = vi.fn(async () => ({ id: BILL_ID }));
    const withUserMutation = vi.fn(async (_userId, callback) => callback({}));
    const service = createBillsService({
      repository: {
        accountExists: vi.fn(async () => true),
        categoryExists: vi.fn(async () => true),
        insertManual,
        recordAudit: vi.fn(async () => undefined),
      } as unknown as BillsRepository,
      withUserMutation,
    });

    await expect(
      service.createBill(USER_ID, {
        canonicalName: "Rent",
        amountCents: 145000n,
        cadence: "monthly",
        nextExpectedDate: "2026-10-01",
        isIncome: false,
        billType: "payable",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(withUserMutation).not.toHaveBeenCalled();
    expect(insertManual).not.toHaveBeenCalled();
  });

  it("fails detection before reporting a queued job when bill dispatch is unavailable", async () => {
    const service = createBillsService();

    await expect(service.queueDetection(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it("fails active confirmed updates inside the mutation boundary when bill dispatch is unavailable", async () => {
    const update = vi.fn(async () => ({
      id: BILL_ID,
      status: "active",
      userConfirmed: true,
    }));
    const withUserMutation = vi.fn(async (_userId, callback) => callback({}));
    const service = createBillsService({
      repository: {
        findById: vi.fn(async () => ({
          id: BILL_ID,
          status: "active",
          userConfirmed: true,
        })),
        update,
      } as unknown as BillsRepository,
      withUserMutation,
    });

    await expect(
      service.updateBill(USER_ID, BILL_ID, { notes: "Updated" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(withUserMutation).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("runs overdue sweep through the public worker function with the tenant id", async () => {
    const sweepOverdue = vi.fn(async () => 2);
    const tx = {};
    const withUserMutation = vi.fn(async (_userId, callback) => callback(tx));

    await expect(
      runOverdueSweep(USER_ID, {
        occurrences: { sweepOverdue } as unknown as BillOccurrencesRepository,
        withUserMutation,
      }),
    ).resolves.toBeUndefined();

    expect(sweepOverdue).toHaveBeenCalledWith(USER_ID, tx);
  });

  it("resolves matured forecast events through the public worker function with tenant predicates", async () => {
    const tx = {};
    const recent = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        recurringSeriesId: BILL_ID,
        date: "2026-09-01",
        amount: 100n,
      },
    ];
    const event = {
      id: "55555555-5555-4555-8555-555555555555",
      recurringSeriesId: BILL_ID,
      date: "2026-09-01",
      amount: 100n,
    };
    const resolveForecastEvent = vi.fn(async () => undefined);
    const repository = {
      listRecentRecurringTransactions: vi.fn(async () => recent),
      listOpenForecastEvents: vi.fn(async () => [event]),
      resolveForecastEvent,
    } as unknown as BillsRepository;
    const occurrences = {
      findProcessing: vi.fn(async () => null),
      listAutoConfirmationCandidates: vi.fn(async () => []),
    } as unknown as BillOccurrencesRepository;
    const withUserMutation = vi.fn(async (_userId, callback) => callback(tx));

    await resolveMaturedForecastEvents(USER_ID, {
      repository,
      occurrences,
      withUserMutation,
    });

    expect(repository.listRecentRecurringTransactions).toHaveBeenCalledWith(
      USER_ID,
      tx,
    );
    expect(repository.listOpenForecastEvents).toHaveBeenCalledWith(
      USER_ID,
      [BILL_ID],
      tx,
    );
    expect(resolveForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      event.id,
      recent[0]!.id,
      tx,
    );
  });

  it("maps a missing occurrence and a terminal occurrence state to typed errors inside the mutation boundary", async () => {
    const withUserMutation = vi.fn(async (_userId: string, callback: any) =>
      callback({}),
    );
    const service = createBillsService({
      repository: {
        accountExists: vi.fn(async () => true),
        recordAudit: vi.fn(async () => undefined),
      } as any,
      occurrences: {
        findById: vi.fn(async (_userId: string, id: string) =>
          id === "missing" ? null : occurrence,
        ),
        updateIfStatus: vi.fn(),
      } as any,
      withUserMutation,
    });
    await expect(
      service.markOccurrencePaid(USER_ID, "missing", {
        accountId: BILL_ID,
        amountCents: 100n,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.skipOccurrence(USER_ID, occurrence.id),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(withUserMutation).toHaveBeenCalledTimes(2);
  });

  it("rejects a bill/occurrence pair that is not owned by the user", async () => {
    const updateOccurrence = vi.fn();
    const withUserMutation = vi.fn(async (_userId: string, callback: any) =>
      callback({}),
    );
    const service = createBillsService({
      occurrences: {
        findEditableOccurrence: vi.fn(async () => null),
        updateOccurrence,
      } as any,
      withUserMutation,
    });

    await expect(
      service.updateOccurrence(USER_ID, BILL_ID, occurrence.id, {
        amountCents: 200n,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(updateOccurrence).not.toHaveBeenCalled();
    expect(withUserMutation).toHaveBeenCalledTimes(1);
  });

  it("rejects terminal occurrences and both date collision classes", async () => {
    const paid = { ...occurrence, status: "paid" as const };
    const repo = {
      findEditableOccurrence: vi.fn(async () => paid),
      hasActiveDateCollision: vi.fn(async () => false),
      hasUnlinkedForecastIdentityCollision: vi.fn(async () => false),
      updateOccurrence: vi.fn(async () => paid),
      updateLinkedForecastEvent: vi.fn(async () => undefined),
    };
    const service = createBillsService({
      occurrences: repo as any,
      withUserMutation: async (_userId, callback) => callback({} as any),
    });
    await expect(
      service.updateOccurrence(USER_ID, BILL_ID, occurrence.id, {
        dueDate: "2026-10-10",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.updateOccurrence).not.toHaveBeenCalled();

    for (const collision of ["active", "forecast"] as const) {
      repo.findEditableOccurrence.mockResolvedValue({
        ...occurrence,
        status: "upcoming",
      } as any);
      repo.hasActiveDateCollision.mockResolvedValue(collision === "active");
      repo.hasUnlinkedForecastIdentityCollision.mockResolvedValue(
        collision === "forecast",
      );
      await expect(
        service.updateOccurrence(USER_ID, BILL_ID, occurrence.id, {
          dueDate: "2026-10-10",
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    }
    expect(repo.updateOccurrence).not.toHaveBeenCalled();
  });

  it("preserves omitted override fields, audits once, updates the linked forecast, and returns effective values", async () => {
    const before = {
      ...occurrence,
      status: "overdue" as const,
      expectedAmountOverrideCents: 200n,
      dueDateOverride: null,
    };
    const after = { ...before, dueDateOverride: "2026-10-10" };
    const tx = {};
    const repo = {
      findEditableOccurrence: vi.fn(async () => before),
      hasActiveDateCollision: vi.fn(async () => false),
      hasUnlinkedForecastIdentityCollision: vi.fn(async () => false),
      updateOccurrence: vi.fn(
        async (_userId, _billId, _occurrenceId, patch) => ({
          ...before,
          ...patch,
        }),
      ),
      updateLinkedForecastEvent: vi.fn(async () => undefined),
    };
    const recordAudit = vi.fn(async () => undefined);
    const cache = { invalidateUser: vi.fn() };
    const withUserMutation = createUserMutationService({
      db: { transaction: async (callback: any) => callback(tx) } as any,
      cache,
      incrementRevision: async () => 1n,
      publishInvalidation: async () => undefined,
    }).withUserMutation;
    const service = createBillsService({
      repository: { recordAudit } as any,
      occurrences: repo as any,
      withUserMutation,
    });

    await expect(
      service.updateOccurrence(USER_ID, BILL_ID, occurrence.id, {
        dueDate: "2026-10-10",
      }),
    ).resolves.toMatchObject({
      dueDate: "2026-10-10",
      expectedAmountCents: "200",
    });
    expect(repo.updateOccurrence).toHaveBeenCalledWith(
      USER_ID,
      BILL_ID,
      occurrence.id,
      { dueDateOverride: "2026-10-10" },
      tx,
    );
    expect(repo.updateLinkedForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      occurrence.id,
      "2026-10-10",
      200n,
      tx,
    );
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        entityType: "bill_occurrence",
        entityId: occurrence.id,
        action: "update",
        source: "bills.override_occurrence",
        before,
        after,
      }),
      tx,
    );
    expect(cache.invalidateUser).toHaveBeenCalledExactlyOnceWith(USER_ID);
  });

  it("clears overrides with null, checks the restored date for collisions, and reports baseline and override values", async () => {
    const before = {
      ...occurrence,
      status: "upcoming" as const,
      dueDate: "2026-10-20",
      expectedAmountCents: 25000n,
      expectedAmountOverrideCents: 17000n,
      dueDateOverride: "2026-10-22",
      linkedTransactionId: null,
    };
    const tx = {};
    const repo = {
      findEditableOccurrence: vi.fn(async () => before),
      hasActiveDateCollision: vi.fn(async () => false),
      hasUnlinkedForecastIdentityCollision: vi.fn(async () => false),
      updateOccurrence: vi.fn(
        async (_userId, _billId, _occurrenceId, patch) => ({
          ...before,
          ...patch,
        }),
      ),
      updateLinkedForecastEvent: vi.fn(async () => undefined),
    };
    const service = createBillsService({
      repository: { recordAudit: vi.fn(async () => undefined) } as any,
      occurrences: repo as any,
      withUserMutation: createUserMutationService({
        db: { transaction: async (callback: any) => callback(tx) } as any,
        cache: { invalidateUser: vi.fn() },
        incrementRevision: async () => 1n,
        publishInvalidation: async () => undefined,
      }).withUserMutation,
    });

    const result = await service.updateOccurrence(
      USER_ID,
      BILL_ID,
      occurrence.id,
      {
        amountCents: null,
        dueDate: null,
      },
    );

    expect(repo.updateOccurrence).toHaveBeenCalledWith(
      USER_ID,
      BILL_ID,
      occurrence.id,
      { expectedAmountOverrideCents: null, dueDateOverride: null },
      tx,
    );
    // Moving back to the scheduled date is still a date change.
    expect(repo.hasActiveDateCollision).toHaveBeenCalledWith(
      USER_ID,
      BILL_ID,
      occurrence.id,
      "2026-10-20",
      tx,
    );
    expect(repo.updateLinkedForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      occurrence.id,
      "2026-10-20",
      25000n,
      tx,
    );
    expect(result).toMatchObject({
      dueDate: "2026-10-20",
      expectedAmountCents: "25000",
      baselineDueDate: "2026-10-20",
      baselineAmountCents: "25000",
      dueDateOverride: null,
      amountOverrideCents: null,
      linkedTransaction: null,
    });
  });

  it("keeps occurrence history newest first and caches it by revision", async () => {
    const old = {
      ...occurrence,
      id: "44444444-4444-4444-8444-444444444444",
      status: "upcoming" as const,
      dueDate: "2026-09-01",
    };
    const service = createBillsService({
      repository: { findById: vi.fn(async () => ({ id: BILL_ID })) } as any,
      occurrences: { listBySetup: vi.fn(async () => [old, occurrence]) } as any,
      getUserRevision: async () => 1n,
      cache: {
        getOrCompute: async (_key: unknown, compute: () => Promise<any>) =>
          compute(),
        invalidateUser: vi.fn(),
      },
    });
    await expect(
      service.listOccurrences(USER_ID, BILL_ID),
    ).resolves.toMatchObject([{ id: occurrence.id }, { id: old.id }]);
  });

  it("returns empty history without a bill existence preflight", async () => {
    const findById = vi.fn();
    const service = createBillsService({
      repository: { findById } as any,
      occurrences: { listBySetup: vi.fn(async () => []) } as any,
      getUserRevision: async () => 1n,
      cache: {
        getOrCompute: async (_key: unknown, compute: () => Promise<any>) =>
          compute(),
        invalidateUser: vi.fn(),
      },
    });

    await expect(service.listOccurrences(USER_ID, BILL_ID)).resolves.toEqual(
      [],
    );
    expect(findById).not.toHaveBeenCalled();
  });

  it("materializes daily bills and exposes worker lifecycle operations through one public port", async () => {
    const bill = {
      id: BILL_ID,
      userConfirmed: true,
      cadence: "daily" as const,
      nextExpectedDate: "2026-09-01",
      accountId: null,
      categoryId: null,
      canonicalName: "Daily transit",
      avgAmount: 250n,
    };
    const upsertBillForecastEvents = vi.fn(async () => undefined);
    const insertOccurrences = vi.fn(async () => []);
    const lifecycle = createBillWorkerLifecycle({
      repository: {
        list: vi.fn(async () => [bill]),
        upsertBillForecastEvents,
        detectionTransactions: vi.fn(async () => []),
        upsertDetected: vi.fn(async () => undefined),
        updateDetection: vi.fn(async () => undefined),
        listRecentRecurringTransactions: vi.fn(async () => []),
        listAutoConfirmationTransactions: vi.fn(async () => []),
        listOpenForecastEvents: vi.fn(async () => []),
        resolveForecastEvent: vi.fn(async () => undefined),
        resolveBillForecastEvent: vi.fn(async () => undefined),
      } as any,
      occurrences: {
        insertOccurrences,
        findProcessing: vi.fn(async () => null),
        listAutoConfirmationCandidates: vi.fn(async () => []),
        updateIfStatus: vi.fn(async () => null),
        sweepOverdue: vi.fn(async () => 2),
      } as any,
      withUserMutation: vi.fn(async (_userId: string, callback: any) =>
        callback({}),
      ),
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    await expect(lifecycle.sweepOverdue(USER_ID)).resolves.toBeUndefined();
    await expect(
      lifecycle.resolveMaturedForecastEvents(USER_ID),
    ).resolves.toBeUndefined();
    await expect(lifecycle.materialize(USER_ID, BILL_ID, 2)).resolves.toEqual({
      setupsMaterialized: 1,
      occurrencesCreated: 62,
    });
    expect(upsertBillForecastEvents).toHaveBeenCalledTimes(1);
    expect(insertOccurrences).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          dueDate: "2026-09-01",
          occurrenceKey: `${BILL_ID}:2026-09-01`,
        }),
        expect.objectContaining({
          dueDate: "2026-11-01",
          occurrenceKey: `${BILL_ID}:2026-11-01`,
        }),
      ]),
      expect.anything(),
    );
  });

  it("confirms only exact amount and inclusive seven-day matches with unique candidates on both sides", async () => {
    const tx = {};
    const candidates = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-09-24",
        amount: 100n,
      },
      {
        id: "44444444-4444-4444-8444-444444444445",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-22",
        amount: 200n,
      },
      {
        id: "44444444-4444-4444-8444-444444444446",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-01",
        amount: 300n,
      },
      {
        id: "44444444-4444-4444-8444-444444444447",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-09",
        amount: 400n,
      },
      {
        id: "44444444-4444-4444-8444-444444444448",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-01",
        amount: 500n,
      },
    ];
    const rows = [
      {
        ...occurrence,
        status: "upcoming",
        dueDate: "2026-10-01",
        expectedAmountCents: 100n,
      },
      {
        ...occurrence,
        id: "33333333-3333-4333-8333-333333333334",
        status: "overdue",
        dueDate: "2026-10-15",
        expectedAmountCents: 200n,
      },
      {
        ...occurrence,
        id: "33333333-3333-4333-8333-333333333335",
        status: "processing",
        dueDate: "2026-10-01",
        expectedAmountCents: 300n,
      },
      {
        ...occurrence,
        id: "33333333-3333-4333-8333-333333333336",
        status: "upcoming",
        dueDate: "2026-10-01",
        expectedAmountCents: 400n,
      },
      {
        ...occurrence,
        id: "33333333-3333-4333-8333-333333333337",
        status: "upcoming",
        dueDate: "2026-10-01",
        expectedAmountCents: 501n,
      },
    ];
    const recent: Array<{
      id: string;
      recurringSeriesId: string | null;
      date: string;
      amount: bigint;
    }> = [];
    const repository = {
      listRecentRecurringTransactions: vi.fn(async () => recent),
      listOpenForecastEvents: vi.fn(async () => []),
      listAutoConfirmationTransactions: vi.fn(async () => candidates),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
      resolveBillForecastEvent: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    } as any;
    const occurrences = {
      listAutoConfirmationCandidates: vi.fn(async () => rows),
      updateIfStatus: vi.fn(async (_userId: string, id: string) => {
        const row = rows.find((candidate) => candidate.id === id);
        return row ? { ...row, status: "paid" } : null;
      }),
    } as any;
    const withUserMutation = vi.fn(async (_userId: string, callback: any) =>
      callback(tx),
    );

    await resolveMaturedForecastEvents(USER_ID, {
      repository,
      occurrences,
      withUserMutation,
    });

    expect(repository.listAutoConfirmationTransactions).toHaveBeenCalledWith(
      USER_ID,
      "2026-09-24",
      "2026-10-22",
      tx,
    );
    expect(occurrences.updateIfStatus).toHaveBeenCalledTimes(3);
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      rows[0]!.id,
      ["upcoming", "overdue", "processing"],
      expect.objectContaining({
        status: "paid",
        linkedTransactionId: candidates[0]!.id,
        paidAccountId: candidates[0]!.accountId,
        paidAmountCents: 100n,
      }),
      tx,
    );
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      rows[1]!.id,
      ["upcoming", "overdue", "processing"],
      expect.objectContaining({
        status: "paid",
        linkedTransactionId: candidates[1]!.id,
        paidAmountCents: 200n,
      }),
      tx,
    );
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      rows[2]!.id,
      ["upcoming", "overdue", "processing"],
      expect.objectContaining({
        status: "paid",
        linkedTransactionId: candidates[2]!.id,
        paidAmountCents: 300n,
      }),
      tx,
    );
    expect(occurrences.updateIfStatus).not.toHaveBeenCalledWith(
      USER_ID,
      rows[3]!.id,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(occurrences.updateIfStatus).not.toHaveBeenCalledWith(
      USER_ID,
      rows[4]!.id,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(repository.resolveBillForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      rows[0]!.id,
      candidates[0]!.id,
      tx,
    );
    expect(repository.recordAudit).toHaveBeenCalledTimes(3);
    expect(repository.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "bill_occurrence",
        entityId: rows[0]!.id,
        source: "bills.auto_confirm_paid",
      }),
      tx,
    );
  });

  it("does not let fuzzy generic recurring matches mark bill occurrences paid", async () => {
    const tx = {};
    const recent = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        recurringSeriesId: BILL_ID,
        date: "2026-10-01",
        amount: 120n,
      },
    ];
    const event = {
      id: "55555555-5555-4555-8555-555555555555",
      recurringSeriesId: BILL_ID,
      date: "2026-10-01",
      amount: 100n,
      billOccurrenceId: null,
    };
    const repository = {
      listRecentRecurringTransactions: vi.fn(async () => recent),
      listOpenForecastEvents: vi.fn(async () => [event]),
      resolveForecastEvent: vi.fn(async () => undefined),
      listAutoConfirmationTransactions: vi.fn(async () => []),
      recordAudit: vi.fn(async () => undefined),
    } as any;
    const occurrences = {
      listAutoConfirmationCandidates: vi.fn(async () => []),
      updateIfStatus: vi.fn(),
    } as any;

    await resolveMaturedForecastEvents(USER_ID, {
      repository,
      occurrences,
      withUserMutation: async (_userId, callback) => callback(tx as any),
    });

    expect(repository.resolveForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      event.id,
      recent[0]!.id,
      tx,
    );
    expect(occurrences.updateIfStatus).not.toHaveBeenCalled();
  });

  it("rejects exact matches when either an occurrence or transaction has multiple candidates", async () => {
    const makeRun = async (
      rows: any[],
      candidates: Array<{
        id: string;
        accountId: string;
        date: string;
        amount: bigint;
      }>,
    ) => {
      const updateIfStatus = vi.fn(async () => null);
      await resolveMaturedForecastEvents(USER_ID, {
        repository: {
          listRecentRecurringTransactions: vi.fn(async () => []),
          listOpenForecastEvents: vi.fn(async () => []),
          listAutoConfirmationTransactions: vi.fn(async () => candidates),
          tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
          resolveBillForecastEvent: vi.fn(async () => undefined),
          recordAudit: vi.fn(async () => undefined),
        } as any,
        occurrences: {
          listAutoConfirmationCandidates: vi.fn(async () => rows),
          updateIfStatus,
        } as any,
        withUserMutation: async (_userId, callback) => callback({} as any),
      });
      expect(updateIfStatus).not.toHaveBeenCalled();
    };
    const row1 = {
      ...occurrence,
      status: "upcoming" as const,
      dueDate: "2026-10-01",
    };
    const row2 = { ...row1, id: "33333333-3333-4333-8333-333333333334" };
    const transaction = {
      id: "44444444-4444-4444-8444-444444444444",
      accountId: "66666666-6666-4666-8666-666666666666",
      date: "2026-10-01",
      amount: 100n,
    };

    await makeRun([row1, row2], [transaction]);
    await makeRun(
      [row1],
      [
        transaction,
        { ...transaction, id: "44444444-4444-4444-8444-444444444445" },
      ],
    );
  });

  it("skips a candidate when another worker holds its transaction claim", async () => {
    const row = {
      ...occurrence,
      status: "upcoming" as const,
      dueDate: "2026-10-01",
    };
    const transaction = {
      id: "44444444-4444-4444-8444-444444444444",
      accountId: "66666666-6666-4666-8666-666666666666",
      date: "2026-10-01",
      amount: 100n,
    };
    const updateIfStatus = vi.fn();
    const repository = {
      listRecentRecurringTransactions: vi.fn(async () => []),
      listOpenForecastEvents: vi.fn(async () => []),
      listAutoConfirmationTransactions: vi.fn(async () => [transaction]),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => false),
      resolveBillForecastEvent: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    } as any;

    await resolveMaturedForecastEvents(USER_ID, {
      repository,
      occurrences: {
        listAutoConfirmationCandidates: vi.fn(async () => [row]),
        updateIfStatus,
      } as any,
      withUserMutation: async (_userId, callback) => callback({} as any),
    });

    expect(repository.tryClaimAutoConfirmationTransaction).toHaveBeenCalledWith(
      USER_ID,
      transaction.id,
      expect.anything(),
    );
    expect(updateIfStatus).not.toHaveBeenCalled();
    expect(repository.resolveBillForecastEvent).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });
});

describe("bills month view", () => {
  const billRow = (
    id: string,
    name: string,
    next: string,
    cadence = "monthly",
  ) => ({
    id,
    userId: USER_ID,
    canonicalName: name,
    cadence: cadence as "monthly",
    status: "active" as const,
    avgAmount: 5000n,
    lastAmount: null,
    nextExpectedDate: next,
    lastOccurredOn: null,
    categoryId: null,
    billType: "transfer" as const,
    accountId: null,
    toAccountId: null,
    confidence: 1,
    sampleCount: 1,
    userConfirmed: true,
    lastPriceChangeAt: null,
    previousAvgAmount: null,
    notes: null,
    createdAt: new Date("2026-09-25T00:00:00.000Z"),
    updatedAt: new Date("2026-09-25T00:00:00.000Z"),
    deletedAt: null,
  });
  const VENTURE = "55555555-5555-4555-8555-555555555555";
  const SAVOR = "66666666-6666-4666-8666-666666666666";
  const TWICE = "77777777-7777-4777-8777-777777777777";
  const occ = (billSetupId: string, dueDate: string, status = "upcoming") => ({
    ...occurrence,
    id: `${billSetupId.slice(0, 8)}-${dueDate}`,
    billSetupId,
    dueDate,
    status: status as "upcoming" | "paid" | "cancelled",
  });
  // Mirrors production 2026-09-25: Venture X's statement bill still says 09-20
  // (Plaid has not refreshed it) but its materialized occurrences start 10-20.
  const occurrences = [
    occ(VENTURE, "2026-10-20"),
    occ(VENTURE, "2026-11-20"),
    occ(SAVOR, "2026-10-01"),
    occ(SAVOR, "2026-11-01", "paid"),
    occ(SAVOR, "2026-12-01", "cancelled"),
  ];
  const service = () =>
    createBillsService({
      repository: {
        list: vi.fn(async () => [
          billRow(VENTURE, "Venture X payment", "2026-09-20"),
          billRow(SAVOR, "Savor payment", "2026-10-01"),
          billRow(TWICE, "Twice monthly", "2026-10-10", "semimonthly"),
        ]),
      } as any,
      occurrences: {
        inRangeForSetups: vi.fn(
          async (_u: string, ids: string[], from: string, to: string) =>
            new Map(
              occurrences
                .filter(
                  (o) =>
                    ids.includes(o.billSetupId) &&
                    o.status !== "cancelled" &&
                    o.dueDate >= from &&
                    o.dueDate <= to,
                )
                .map((o) => [o.billSetupId, o]),
            ),
        ),
        setupIdsWithOccurrences: vi.fn(
          async () => new Set(occurrences.map((o) => o.billSetupId)),
        ),
      } as any,
      cache: {
        getOrCompute: async (_key: unknown, read: any) => read(),
      } as any,
      getUserRevision: async () => 1n,
    });
  const view = async (month: string) =>
    (await service().listBills(USER_ID, month)).series.map((bill) => [
      bill.canonicalName,
      bill.currentOccurrence?.dueDate ?? bill.nextExpectedDate,
      bill.currentOccurrence?.status ?? null,
    ]);

  it("lists each bill in every month it has an occurrence, with that month's due date", async () => {
    await expect(view("2026-10")).resolves.toEqual([
      ["Savor payment", "2026-10-01", "upcoming"],
      ["Twice monthly", "2026-10-10", null],
      ["Venture X payment", "2026-10-20", "upcoming"],
    ]);
    await expect(view("2026-11")).resolves.toEqual([
      ["Savor payment", "2026-11-01", "paid"],
      ["Venture X payment", "2026-11-20", "upcoming"],
    ]);
  });

  it("does not place a bill in a month by a stale nextExpectedDate once it has occurrences", async () => {
    await expect(view("2026-09")).resolves.toEqual([]);
    await expect(view("2026-12")).resolves.toEqual([]);
  });
});
