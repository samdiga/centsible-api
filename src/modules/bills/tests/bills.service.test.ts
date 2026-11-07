/* eslint-disable @typescript-eslint/no-explicit-any -- narrow repository doubles intentionally expose only the methods under test. */
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../../platform/errors/app-error.js";
import {
  createBillWorkerLifecycle,
  createBillsService,
  materializeBillsForUser,
  runOverdueSweep,
  resolveMaturedForecastEvents,
} from "../bills.service.js";
import type { BillsRepository } from "../bills.repository.js";
import type { BillOccurrencesRepository } from "../bill-occurrences.repository.js";
import { createUserMutationService } from "../../../platform/cache/user-revisions.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BILL_ID = "22222222-2222-4222-8222-222222222222";

describe("card statement materialization", () => {
  const card = {
    type: "credit",
    statementDate: "2026-09-20",
    statementBalance: 12345n,
    paymentDueDate: "2026-10-15",
  };
  async function materialize(
    account: unknown,
    now = "2026-09-26",
    names: { displayName?: string | null; accountLabel?: string | null } = {},
  ) {
    const insertOccurrences = vi.fn(async (rows: any[]) =>
      rows.map((row, index) => ({
        ...row,
        id: String(index),
        status: "upcoming",
      })),
    );
    const upsertBillForecastEvents = vi.fn(async () => undefined);
    const reviveCancelled = vi.fn(async () => undefined);
    await materializeBillsForUser(USER_ID, BILL_ID, 12, {
      repository: {
        list: async () => [
          {
            id: BILL_ID,
            billType: "transfer",
            toAccountId: "card",
            userConfirmed: true,
            cadence: "monthly",
            nextExpectedDate: "2026-09-15",
            avgAmount: 999n,
            accountId: null,
            categoryId: null,
            canonicalName: "Card payment",
            ...names,
          },
        ],
        findTransferAccount: async () => account,
        upsertBillForecastEvents,
      } as any,
      occurrences: {
        insertOccurrences,
        reviveCancelled,
        listBySetup: async () => [],
      } as any,
      withUserMutation: async (_id, callback) => callback({} as any),
      now: () => new Date(`${now}T12:00:00Z`),
    });
    return { insertOccurrences, upsertBillForecastEvents, reviveCancelled };
  }
  it("uses only the actual statement amount and due date, never future months", async () => {
    const { insertOccurrences, upsertBillForecastEvents } =
      await materialize(card);
    expect(insertOccurrences).toHaveBeenCalledWith(
      [
        {
          userId: USER_ID,
          billSetupId: BILL_ID,
          occurrenceKey: `${BILL_ID}:2026-10`,
          dueDate: "2026-10-15",
          expectedAmountCents: 12345n,
        },
      ],
      expect.anything(),
    );
    expect(upsertBillForecastEvents).toHaveBeenCalledWith(
      [expect.objectContaining({ amountCents: 12345n, date: "2026-10-15" })],
      expect.anything(),
    );
  });
  it("names the forecast event after the card's account label (T-185)", async () => {
    const { upsertBillForecastEvents } = await materialize(card, undefined, {
      displayName: null,
      accountLabel: "Chase Freedom payment",
    });
    expect(upsertBillForecastEvents).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "Chase Freedom payment" })],
      expect.anything(),
    );
  });
  it("keeps an overdue actual statement instead of rolling it into a future month", async () => {
    const { insertOccurrences } = await materialize(card, "2026-11-01");
    expect(insertOccurrences.mock.calls[0]?.[0]).toHaveLength(1);
    expect(insertOccurrences.mock.calls[0]?.[0][0]).toMatchObject({
      dueDate: "2026-10-15",
      expectedAmountCents: 12345n,
    });
  });
  it("brings back the statement month's cancelled estimate, not other months", async () => {
    const { reviveCancelled } = await materialize(card);
    expect(reviveCancelled.mock.calls).toEqual([
      [USER_ID, BILL_ID, `${BILL_ID}:2026-10`, expect.anything()],
    ]);
  });
  it("treats a bank due date and balance without a statement date as issued", async () => {
    const { insertOccurrences } = await materialize({
      ...card,
      statementDate: null,
    });
    expect(insertOccurrences.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ dueDate: "2026-10-15", expectedAmountCents: 12345n }),
    ]);
  });
  it.each([
    null,
    { ...card, statementBalance: null },
    { ...card, paymentDueDate: null },
    { ...card, statementBalance: 0n },
    { ...card, statementBalance: -100n },
  ])(
    "does not invent a card bill without a payable issued statement (case %#)",
    async (account) => {
      const { insertOccurrences } = await materialize(account);
      expect(insertOccurrences).not.toHaveBeenCalled();
    },
  );
  it("preserves monthly loan recurrence", async () => {
    const { insertOccurrences } = await materialize({ ...card, type: "loan" });
    expect(insertOccurrences.mock.calls[0]?.[0].length).toBeGreaterThan(1);
  });
});
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

/** A bill the auto-match rule can pair with `netflixPayment` rows. */
const matchSetup = {
  id: BILL_ID,
  status: "active" as const,
  accountId: null,
  billType: "payable" as const,
  canonicalName: "Netflix",
  displayName: null,
  merchantPatterns: ["netflix"],
  isIncome: false,
  userConfirmed: true,
};
const netflixPayment = {
  isCard: false,
  merchantName: "Netflix",
  name: "NETFLIX.COM",
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
        listBySetup: vi.fn(async () => []),
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

  it("gives the matched payment the bill's category, and only when the bill has one", async () => {
    const tx = {};
    const CATEGORY_ID = "77777777-7777-4777-8777-777777777777";
    const candidate = {
      id: "44444444-4444-4444-8444-444444444444",
      accountId: "66666666-6666-4666-8666-666666666666",
      date: "2026-10-01",
      amount: 100n,
      ...netflixPayment,
    };
    const run = async (categoryId: string | null, applied: boolean) => {
      const repository = {
        listRecentRecurringTransactions: vi.fn(async () => []),
        listOpenForecastEvents: vi.fn(async () => []),
        list: vi.fn(async () => [matchSetup]),
        listAutoConfirmationTransactions: vi.fn(async () => [candidate]),
        tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
        resolveBillForecastEvent: vi.fn(async () => undefined),
        recordAudit: vi.fn(async () => undefined),
        findById: vi.fn(async () => ({
          id: BILL_ID,
          categoryId,
          merchantPatterns: ["netflix"],
        })),
        applyBillCategoryToTransaction: vi.fn(async () => applied),
      } as any;
      const row = { ...occurrence, status: "upcoming" as const };
      const occurrences = {
        listAutoConfirmationCandidates: vi.fn(async () => [row]),
        updateIfStatus: vi.fn(async () => ({ ...row, status: "paid" })),
      } as any;
      await resolveMaturedForecastEvents(USER_ID, {
        repository,
        occurrences,
        withUserMutation: vi.fn(async (_userId: string, callback: any) =>
          callback(tx),
        ),
      });
      return repository;
    };

    const withCategory = await run(CATEGORY_ID, true);
    expect(withCategory.findById).toHaveBeenCalledWith(USER_ID, BILL_ID, tx);
    expect(withCategory.applyBillCategoryToTransaction).toHaveBeenCalledWith(
      USER_ID,
      candidate.id,
      CATEGORY_ID,
      tx,
    );
    expect(withCategory.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "transaction",
        entityId: candidate.id,
        source: "bills.apply_category",
      }),
      tx,
    );

    // Unchanged (e.g. picked by hand): no second audit row.
    const handPicked = await run(CATEGORY_ID, false);
    expect(handPicked.recordAudit).toHaveBeenCalledTimes(1);

    const noCategory = await run(null, false);
    expect(noCategory.applyBillCategoryToTransaction).not.toHaveBeenCalled();
  });

  it("confirms only exact amount and inclusive seven-day matches with unique candidates on both sides", async () => {
    const tx = {};
    const candidates = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-09-24",
        amount: 100n,
        ...netflixPayment,
      },
      {
        id: "44444444-4444-4444-8444-444444444445",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-22",
        amount: 200n,
        ...netflixPayment,
      },
      {
        id: "44444444-4444-4444-8444-444444444446",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-01",
        amount: 300n,
        ...netflixPayment,
      },
      {
        id: "44444444-4444-4444-8444-444444444447",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-09",
        amount: 400n,
        ...netflixPayment,
      },
      {
        id: "44444444-4444-4444-8444-444444444448",
        accountId: "66666666-6666-4666-8666-666666666666",
        date: "2026-10-01",
        amount: 500n,
        ...netflixPayment,
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
      list: vi.fn(async () => [matchSetup]),
      listAutoConfirmationTransactions: vi.fn(async () => candidates),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
      findById: vi.fn(async () => null),
      applyBillCategoryToTransaction: vi.fn(async () => false),
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
        ...netflixPayment,
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
      list: vi.fn(async () => []),
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
          list: vi.fn(async () => [matchSetup]),
          listAutoConfirmationTransactions: vi.fn(async () => candidates),
          tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
          findById: vi.fn(async () => null),
          applyBillCategoryToTransaction: vi.fn(async () => false),
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
      ...netflixPayment,
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
      ...netflixPayment,
    };
    const updateIfStatus = vi.fn();
    const repository = {
      listRecentRecurringTransactions: vi.fn(async () => []),
      listOpenForecastEvents: vi.fn(async () => []),
      list: vi.fn(async () => [matchSetup]),
      listAutoConfirmationTransactions: vi.fn(async () => [transaction]),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => false),
      findById: vi.fn(async () => null),
      applyBillCategoryToTransaction: vi.fn(async () => false),
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

describe("bill auto-match rule", () => {
  const CHECKING = "66666666-6666-4666-8666-666666666666";
  const OTHER_CHECKING = "66666666-6666-4666-8666-666666666667";
  const robinhood = {
    ...matchSetup,
    canonicalName: "Robinhood",
    merchantPatterns: [],
    accountId: CHECKING,
  };
  const payment = (id: string, overrides: Record<string, unknown> = {}) => ({
    id: `44444444-4444-4444-8444-44444444444${id}`,
    accountId: CHECKING,
    date: "2026-10-01",
    amount: 20000n,
    isCard: false,
    merchantName: "Robinhood",
    name: "ROBINHOOD DES:FUNDS ID:123",
    ...overrides,
  });
  const due = (id: string, dueDate: string) => ({
    ...occurrence,
    id: `33333333-3333-4333-8333-33333333333${id}`,
    status: "upcoming" as const,
    dueDate,
    expectedAmountCents: 20000n,
  });
  const run = async (
    setup: Record<string, unknown>,
    rows: any[],
    posted: any[],
    pending: any[] = [],
    overrides: Record<string, unknown> = {},
  ) => {
    const tx = {};
    const repository = {
      listRecentRecurringTransactions: vi.fn(async () => []),
      listOpenForecastEvents: vi.fn(async () => []),
      list: vi.fn(async () => [setup]),
      listAutoConfirmationTransactions: vi.fn(async () => posted),
      listPendingConfirmationTransactions: vi.fn(async () => pending),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
      findById: vi.fn(async () => setup),
      update: vi.fn(async () => setup),
      applyBillCategoryToTransaction: vi.fn(async () => false),
      resolveBillForecastEvent: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
      ...overrides,
    } as any;
    const updateIfStatus = vi.fn(
      async (_userId: string, id: string, _from: unknown, patch: object) => {
        const row = rows.find((candidate) => candidate.id === id);
        return row ? { ...row, ...patch } : null;
      },
    );
    await resolveMaturedForecastEvents(USER_ID, {
      repository,
      occurrences: {
        listAutoConfirmationCandidates: vi.fn(async () => rows),
        updateIfStatus,
      } as any,
      withUserMutation: async (_userId, callback) => callback(tx as any),
    });
    const links = updateIfStatus.mock.calls.map(([, id, , patch]) => ({
      occurrenceId: id,
      ...(patch as {
        linkedTransactionId?: string;
        pendingTransactionId?: string;
      }),
    }));
    return { repository, links };
  };

  it("does not pay a Robinhood bill with a same-amount Fidelity transfer from its account", async () => {
    const { links } = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [
        payment("1", {
          merchantName: "Fidelity",
          name: "FIDELITY INVESTMENTS MONEYLINE",
        }),
      ],
    );
    expect(links).toEqual([]);
  });

  it("does not pay a bill from an account other than its Paid-from account", async () => {
    const { links } = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [payment("1", { accountId: OTHER_CHECKING })],
    );
    expect(links).toEqual([]);
  });

  it("pays from the Paid-from account when the merchant matches loosely", async () => {
    const { links } = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [payment("1", { merchantName: null })],
    );
    expect(links).toEqual([
      expect.objectContaining({
        occurrenceId: due("1", "").id,
        status: "paid",
        linkedTransactionId: payment("1").id,
      }),
    ]);
  });

  it("without a Paid-from account, matches any account but only on the merchant", async () => {
    const disney = {
      ...matchSetup,
      canonicalName: "Disney+",
      merchantPatterns: [],
    };
    const rows = [due("1", "2026-10-01")];
    const unrelated = await run(disney, rows, [
      payment("1", { merchantName: "Amazon", name: "AMAZON MKTPL" }),
    ]);
    expect(unrelated.links).toEqual([]);
    const matched = await run(disney, rows, [
      payment("1", {
        accountId: OTHER_CHECKING,
        merchantName: null,
        name: "DISNEY PLUS ADY",
      }),
    ]);
    expect(matched.links).toEqual([
      expect.objectContaining({ linkedTransactionId: payment("1").id }),
    ]);
  });

  it("pays a card statement bill from checking when the payment names the card's bank", async () => {
    const CARD = "66666666-6666-4666-8666-666666666668";
    const statementBill = {
      ...matchSetup,
      canonicalName: "Sapphire Preferred payment",
      merchantPatterns: [],
      billType: "transfer" as const,
      toAccountId: CARD,
    };
    const chasePayment = payment("1", {
      merchantName: null,
      name: "CHASE CREDIT CRD EPAY",
    });
    const withoutNames = await run(
      statementBill,
      [due("1", "2026-10-01")],
      [chasePayment],
    );
    expect(withoutNames.links).toEqual([]);

    const tx = {};
    const listAccountPayeeNames = vi.fn(
      async () => new Map([[CARD, ["Sapphire Preferred", "Chase"]]]),
    );
    const updateIfStatus = vi.fn(async () => ({
      ...occurrence,
      status: "paid",
    }));
    await resolveMaturedForecastEvents(USER_ID, {
      repository: {
        listRecentRecurringTransactions: vi.fn(async () => []),
        listOpenForecastEvents: vi.fn(async () => []),
        list: vi.fn(async () => [statementBill]),
        listAccountPayeeNames,
        listAutoConfirmationTransactions: vi.fn(async () => [chasePayment]),
        tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
        findById: vi.fn(async () => statementBill),
        update: vi.fn(),
        applyBillCategoryToTransaction: vi.fn(async () => false),
        resolveBillForecastEvent: vi.fn(async () => undefined),
        recordAudit: vi.fn(async () => undefined),
      } as any,
      occurrences: {
        listAutoConfirmationCandidates: vi.fn(async () => [
          due("1", "2026-10-01"),
        ]),
        updateIfStatus,
      } as any,
      withUserMutation: async (_userId, callback) => callback(tx as any),
    });
    expect(listAccountPayeeNames).toHaveBeenCalledWith(USER_ID, [CARD], tx);
    expect(updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      due("1", "").id,
      expect.anything(),
      expect.objectContaining({ linkedTransactionId: chasePayment.id }),
      tx,
    );
  });

  it("pays a card statement bill when the card shows the payment arriving, whatever the bank called it", async () => {
    const CARD = "66666666-6666-4666-8666-666666666668";
    const platinumBill = {
      ...matchSetup,
      canonicalName: "Platinum Card® payment",
      merchantPatterns: [],
      billType: "transfer" as const,
      toAccountId: CARD,
    };
    const amexPayment = payment("1", {
      date: "2026-10-02",
      merchantName: null,
      name: "AMEX EPAYMENT",
    });
    const runWith = async (arrivedAmount: bigint) => {
      const tx = {};
      const listAccountInflows = vi.fn(async () => [
        { accountId: CARD, date: "2026-10-01", amount: arrivedAmount },
      ]);
      const updateIfStatus = vi.fn(async () => ({
        ...occurrence,
        status: "paid",
      }));
      await resolveMaturedForecastEvents(USER_ID, {
        repository: {
          listRecentRecurringTransactions: vi.fn(async () => []),
          listOpenForecastEvents: vi.fn(async () => []),
          list: vi.fn(async () => [platinumBill]),
          listAccountPayeeNames: vi.fn(
            async () =>
              new Map([
                [CARD, ["Platinum Card", "Amex Platinum", "American Express"]],
              ]),
          ),
          listAccountInflows,
          listAutoConfirmationTransactions: vi.fn(async () => [amexPayment]),
          tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
          findById: vi.fn(async () => platinumBill),
          update: vi.fn(),
          applyBillCategoryToTransaction: vi.fn(async () => false),
          resolveBillForecastEvent: vi.fn(async () => undefined),
          recordAudit: vi.fn(async () => undefined),
        } as any,
        occurrences: {
          listAutoConfirmationCandidates: vi.fn(async () => [
            due("1", "2026-10-06"),
          ]),
          updateIfStatus,
        } as any,
        withUserMutation: async (_userId, callback) => callback(tx as any),
      });
      return { tx, listAccountInflows, updateIfStatus };
    };

    const arrived = await runWith(20000n);
    // Payments due 2026-10-06 are searched from 09-29 to 10-13; arrivals
    // a further 5 days either side.
    expect(arrived.listAccountInflows).toHaveBeenCalledWith(
      USER_ID,
      [CARD],
      "2026-09-24",
      "2026-10-18",
      arrived.tx,
    );
    expect(arrived.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      due("1", "").id,
      expect.anything(),
      expect.objectContaining({ linkedTransactionId: amexPayment.id }),
      arrived.tx,
    );

    const otherAmount = await runWith(2131n);
    expect(otherAmount.updateIfStatus).not.toHaveBeenCalled();
  });

  it("never re-links a payment the user unmatched, posted or pending, but still takes another", async () => {
    const rows = [due("1", "2026-10-01")];
    const rejected = new Set([`${rows[0]!.id}:${payment("1").id}`]);
    const listRejectedPairs = vi.fn(async () => rejected);
    const posted = await run(
      robinhood,
      rows,
      [payment("1"), payment("2", { date: "2026-10-04" })],
      [],
      { listRejectedPairs },
    );
    expect(listRejectedPairs).toHaveBeenCalledWith(
      USER_ID,
      [rows[0]!.id],
      expect.anything(),
    );
    expect(posted.links).toEqual([
      expect.objectContaining({ linkedTransactionId: payment("2").id }),
    ]);
    const pending = await run(robinhood, rows, [], [payment("1")], {
      listRejectedPairs,
    });
    expect(pending.links).toEqual([]);
  });

  it("takes the closest-dated payment when several qualify", async () => {
    const { links } = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [
        payment("1", { date: "2026-09-27" }),
        payment("2", { date: "2026-10-02" }),
      ],
    );
    expect(links).toEqual([
      expect.objectContaining({ linkedTransactionId: payment("2").id }),
    ]);
  });

  it("pays this week's occurrence of a weekly bill even though next week's is in the window", async () => {
    const { links } = await run(
      robinhood,
      [due("1", "2026-10-01"), due("2", "2026-10-08")],
      [payment("1", { date: "2026-10-01" })],
    );
    expect(links).toEqual([
      expect.objectContaining({
        occurrenceId: due("1", "").id,
        linkedTransactionId: payment("1").id,
      }),
    ]);
  });

  it("leaves equally close candidates for the user", async () => {
    const { links } = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [
        payment("1", { date: "2026-09-29" }),
        payment("2", { date: "2026-10-03" }),
      ],
    );
    expect(links).toEqual([]);
  });

  it("applies the same rule to pending payments", async () => {
    const wrongAccount = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [],
      [payment("1", { accountId: OTHER_CHECKING })],
    );
    expect(wrongAccount.links).toEqual([]);
    const matched = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [],
      [payment("1")],
    );
    expect(matched.links).toEqual([
      expect.objectContaining({
        status: "processing",
        pendingTransactionId: payment("1").id,
      }),
    ]);
  });

  it("learns the bank's merchant spelling from a confirmed payment, once", async () => {
    const first = await run(
      robinhood,
      [due("1", "2026-10-01")],
      [payment("1", { merchantName: null })],
    );
    expect(first.repository.update).toHaveBeenCalledWith(
      USER_ID,
      BILL_ID,
      { merchantPatterns: ["robinhood des funds id"] },
      expect.anything(),
    );
    expect(first.repository.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "bill_setup",
        source: "bills.learn_merchant",
      }),
      expect.anything(),
    );
    const again = await run(
      { ...robinhood, merchantPatterns: ["robinhood des funds id"] },
      [due("1", "2026-10-01")],
      [payment("1", { merchantName: null })],
    );
    expect(again.repository.update).not.toHaveBeenCalled();
  });

  it("does not learn a merchant the bill's names do not match when an old pending link settles", async () => {
    const pendingRow = {
      ...due("1", "2026-10-01"),
      status: "processing" as const,
      pendingTransactionId: payment("1").id,
    };
    const fidelity = payment("1", {
      merchantName: "Fidelity",
      name: "FIDELITY INVESTMENTS",
    });
    const tx = {};
    const repository = {
      listRecentRecurringTransactions: vi.fn(async () => []),
      listOpenForecastEvents: vi.fn(async () => []),
      list: vi.fn(async () => [robinhood]),
      listAutoConfirmationTransactions: vi.fn(async () => []),
      listPendingLinkStates: vi.fn(async () => [
        {
          ...fidelity,
          status: "posted",
          deletedAt: null,
          plaidTransactionId: null,
        },
      ]),
      listPostedReplacements: vi.fn(async () => []),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
      findById: vi.fn(async () => robinhood),
      update: vi.fn(),
      applyBillCategoryToTransaction: vi.fn(async () => false),
      resolveBillForecastEvent: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    } as any;
    await resolveMaturedForecastEvents(USER_ID, {
      repository,
      occurrences: {
        listAutoConfirmationCandidates: vi.fn(async () => [pendingRow]),
        updateIfStatus: vi.fn(async () => ({ ...pendingRow, status: "paid" })),
        localToday: vi.fn(async () => "2026-10-05"),
      } as any,
      withUserMutation: async (_userId, callback) => callback(tx as any),
    });
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe("slot bills from one split series", () => {
  it("pays both Fidelity $50 Monday bills with the two Monday $50 transfers", async () => {
    const CHECKING = "66666666-6666-4666-8666-666666666666";
    const slot = (n: number) => ({
      ...matchSetup,
      id: `22222222-2222-4222-8222-22222222222${n}`,
      canonicalName: `fidelity $50 ${n}/2`,
      displayName: `Fidelity $50 (${n} of 2)`,
      merchantPatterns: [],
      accountId: CHECKING,
    });
    const due = (n: number) => ({
      ...occurrence,
      id: `33333333-3333-4333-8333-33333333333${n}`,
      billSetupId: slot(n).id,
      status: "upcoming" as const,
      dueDate: "2026-10-05",
      expectedAmountCents: 5000n,
    });
    const transferOf = (n: number) => ({
      id: `44444444-4444-4444-8444-44444444444${n}`,
      accountId: CHECKING,
      date: "2026-10-05",
      amount: 5000n,
      isCard: false,
      merchantName: "Fidelity",
      name: "FIDELITY INVESTMENTS",
    });
    const rows = [due(1), due(2)];
    const updateIfStatus = vi.fn(
      async (_u: string, id: string, _from: unknown, patch: object) => ({
        ...rows.find((row) => row.id === id)!,
        ...patch,
      }),
    );
    await resolveMaturedForecastEvents(USER_ID, {
      repository: {
        listRecentRecurringTransactions: vi.fn(async () => []),
        listOpenForecastEvents: vi.fn(async () => []),
        list: vi.fn(async () => [slot(1), slot(2)]),
        listAutoConfirmationTransactions: vi.fn(async () => [
          transferOf(2),
          transferOf(1),
        ]),
        tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
        findById: vi.fn(async () => null),
        applyBillCategoryToTransaction: vi.fn(async () => false),
        resolveBillForecastEvent: vi.fn(async () => undefined),
        recordAudit: vi.fn(async () => undefined),
      } as any,
      occurrences: {
        listAutoConfirmationCandidates: vi.fn(async () => rows),
        updateIfStatus,
      } as any,
      withUserMutation: async (_userId, callback) => callback({} as any),
    });
    const links = updateIfStatus.mock.calls.map(([, id, , patch]) => [
      id,
      (patch as { linkedTransactionId?: string }).linkedTransactionId,
    ]);
    expect(links.sort()).toEqual([
      [due(1).id, transferOf(1).id],
      [due(2).id, transferOf(2).id],
    ]);
  });
});

describe("matching a bill payment by hand", () => {
  const CHECKING = "66666666-6666-4666-8666-666666666666";
  const PAID = "44444444-4444-4444-8444-444444444441";
  const OTHER = "44444444-4444-4444-8444-444444444442";
  const paidRow = {
    ...occurrence,
    status: "paid" as const,
    dueDate: "2026-10-01",
    dueDateOverride: null,
    expectedAmountCents: 20000n,
    expectedAmountOverrideCents: null,
    pendingTransactionId: null,
    linkedTransactionId: PAID,
    paidAccountId: CHECKING,
    paidAmountCents: 20000n,
    confirmedPaidAt: new Date("2026-10-02T00:00:00Z"),
  };
  const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    accountId: CHECKING,
    accountName: "Capital One Checking",
    date: "2026-10-01",
    amount: 20000n,
    isCard: false,
    merchantName: null,
    name: "ROBINHOOD DES:FUNDS",
    ...overrides,
  });
  const setup = {
    id: BILL_ID,
    canonicalName: "robinhood",
    displayName: null,
    merchantPatterns: [],
    billType: "payable",
    toAccountId: null,
    categoryId: null,
  };
  const build = (
    row: any,
    candidates: any[] = [],
    overrides: Record<string, unknown> = {},
  ) => {
    const repository = {
      findById: vi.fn(async () => setup),
      listLinkCandidates: vi.fn(async () => candidates),
      listAccountPayeeNames: vi.fn(async () => new Map()),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
      rejectMatch: vi.fn(async () => undefined),
      clearRejection: vi.fn(async () => undefined),
      reopenBillForecastEvent: vi.fn(async () => undefined),
      resolveBillForecastEvent: vi.fn(async () => undefined),
      applyBillCategoryToTransaction: vi.fn(async () => false),
      update: vi.fn(async () => setup),
      recordAudit: vi.fn(async () => undefined),
      ...overrides,
    };
    const occurrences = {
      findEditableOccurrence: vi.fn(async () => row),
      findById: vi.fn(async () => row),
      updateIfStatus: vi.fn(
        async (_u: string, _id: string, _from: unknown, patch: object) => ({
          ...row,
          ...patch,
        }),
      ),
      linkedTransactionSummaries: vi.fn(async () => new Map()),
      localToday: vi.fn(async () => "2026-10-05"),
    };
    const tx = {};
    const service = createBillsService({
      repository: repository as unknown as BillsRepository,
      occurrences: occurrences as unknown as BillOccurrencesRepository,
      withUserMutation: vi.fn(async (_userId, callback) => callback(tx as any)),
      now: () => new Date("2026-10-05T12:00:00Z"),
    });
    return { service, repository, occurrences, tx };
  };

  it("unmatches a paid occurrence: overdue again, pair rejected, forecast reopened", async () => {
    const { service, repository, occurrences, tx } = build(paidRow);
    const dto = await service.unlinkOccurrence(USER_ID, BILL_ID, paidRow.id);
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      ["paid", "processing"],
      {
        status: "overdue",
        linkedTransactionId: null,
        pendingTransactionId: null,
        paidAccountId: null,
        paidAmountCents: null,
        markedPaidAt: null,
        confirmedPaidAt: null,
      },
      tx,
    );
    expect(repository.rejectMatch).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      PAID,
      tx,
    );
    expect(repository.reopenBillForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      PAID,
      tx,
    );
    expect(repository.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ source: "bills.user_unlink" }),
      tx,
    );
    expect(dto).toMatchObject({ status: "overdue", linkedTransaction: null });
  });

  it("unmatches a payment for a bill due today back to upcoming, not overdue", async () => {
    const { service, occurrences } = build({
      ...paidRow,
      dueDate: "2026-10-05",
    });
    await service.unlinkOccurrence(USER_ID, BILL_ID, paidRow.id);
    expect(occurrences.localToday).toHaveBeenCalledWith(
      USER_ID,
      new Date("2026-10-05T12:00:00Z"),
      expect.anything(),
    );
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      ["paid", "processing"],
      expect.objectContaining({ status: "upcoming" }),
      expect.anything(),
    );
  });

  it("unmatches a pending hold on a future occurrence back to upcoming", async () => {
    const { service, repository, occurrences } = build({
      ...paidRow,
      status: "processing",
      dueDate: "2026-10-09",
      linkedTransactionId: null,
      pendingTransactionId: OTHER,
    });
    await service.unlinkOccurrence(USER_ID, BILL_ID, paidRow.id);
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      ["paid", "processing"],
      expect.objectContaining({ status: "upcoming" }),
      expect.anything(),
    );
    expect(repository.rejectMatch).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      OTHER,
      expect.anything(),
    );
  });

  it("refuses to unmatch an occurrence with no matched payment, or another bill's", async () => {
    const unmatched = build({
      ...paidRow,
      status: "processing",
      linkedTransactionId: null,
    });
    await expect(
      unmatched.service.unlinkOccurrence(USER_ID, BILL_ID, paidRow.id),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(unmatched.repository.rejectMatch).not.toHaveBeenCalled();
    const missing = build(null);
    await expect(
      missing.service.unlinkOccurrence(USER_ID, BILL_ID, paidRow.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("changes the match to a payment the user picks, rejecting the old one and learning the name", async () => {
    const picked = candidate(OTHER, {
      date: "2026-10-03",
      name: "ROBINHOOD SECURITIES",
    });
    const { service, repository, occurrences, tx } = build(paidRow, [
      candidate("44444444-4444-4444-8444-444444444449"),
      picked,
    ]);
    await service.linkOccurrence(USER_ID, BILL_ID, paidRow.id, {
      transactionId: OTHER,
    });
    expect(repository.listLinkCandidates).toHaveBeenCalledWith(
      USER_ID,
      "2026-08-31",
      "2026-11-01",
      paidRow.id,
      tx,
    );
    expect(repository.tryClaimAutoConfirmationTransaction).toHaveBeenCalledWith(
      USER_ID,
      OTHER,
      tx,
      paidRow.id,
    );
    expect(repository.rejectMatch).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      PAID,
      tx,
    );
    expect(repository.reopenBillForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      PAID,
      tx,
    );
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      ["upcoming", "overdue", "processing", "paid"],
      expect.objectContaining({
        status: "paid",
        linkedTransactionId: OTHER,
        pendingTransactionId: null,
        paidAccountId: CHECKING,
        paidAmountCents: 20000n,
      }),
      tx,
    );
    expect(repository.clearRejection).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      OTHER,
      tx,
    );
    expect(repository.resolveBillForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      paidRow.id,
      OTHER,
      tx,
    );
    expect(repository.update).toHaveBeenCalledWith(
      USER_ID,
      BILL_ID,
      { merchantPatterns: ["robinhood securities"] },
      tx,
    );
    expect(repository.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ source: "bills.user_link" }),
      tx,
    );
  });

  it("refuses payments outside the window, already used, or for income", async () => {
    const outside = build({ ...paidRow, linkedTransactionId: null }, []);
    await expect(
      outside.service.linkOccurrence(USER_ID, BILL_ID, paidRow.id, {
        transactionId: OTHER,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(outside.occurrences.updateIfStatus).not.toHaveBeenCalled();

    const taken = build(
      { ...paidRow, linkedTransactionId: null },
      [candidate(OTHER)],
      { tryClaimAutoConfirmationTransaction: vi.fn(async () => false) },
    );
    await expect(
      taken.service.linkOccurrence(USER_ID, BILL_ID, paidRow.id, {
        transactionId: OTHER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(taken.occurrences.updateIfStatus).not.toHaveBeenCalled();

    const income = build({ ...paidRow, expectedAmountCents: -20000n }, [
      candidate(OTHER),
    ]);
    await expect(
      income.service.linkOccurrence(USER_ID, BILL_ID, paidRow.id, {
        transactionId: OTHER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("does nothing when the picked payment is already the match", async () => {
    const { service, occurrences, repository } = build(paidRow, [
      candidate(PAID),
    ]);
    await service.linkOccurrence(USER_ID, BILL_ID, paidRow.id, {
      transactionId: PAID,
    });
    expect(occurrences.updateIfStatus).not.toHaveBeenCalled();
    expect(repository.rejectMatch).not.toHaveBeenCalled();
  });

  it("lists same amount first, then merchant, then the closest date", async () => {
    const { service } = build(paidRow, [
      candidate("a0000000-0000-4000-8000-000000000001", {
        amount: 1500n,
        name: "ROBINHOOD DES:FEE",
        date: "2026-10-01",
      }),
      candidate("a0000000-0000-4000-8000-000000000002", {
        name: "FIDELITY INVESTMENTS",
        date: "2026-09-30",
      }),
      candidate("a0000000-0000-4000-8000-000000000003", {
        name: "FIDELITY INVESTMENTS",
        date: "2026-10-01",
      }),
      candidate(PAID, { date: "2026-10-04" }),
      candidate("a0000000-0000-4000-8000-000000000004", {
        amount: 990n,
        name: "AMAZON",
        date: "2026-10-01",
      }),
    ]);
    const list = await service.listLinkCandidates(USER_ID, BILL_ID, paidRow.id);
    expect(
      list.map((row) => [row.id.slice(-1), row.sameAmount, row.merchantMatch]),
    ).toEqual([
      ["1", true, true],
      ["3", true, false],
      ["2", true, false],
      ["1", false, true],
      ["4", false, false],
    ]);
    expect(list[0]).toMatchObject({
      id: PAID,
      isCurrent: true,
      accountName: "Capital One Checking",
      amountCents: "20000",
    });
    expect(list.filter((row) => row.isCurrent)).toHaveLength(1);
  });

  it("does not list candidates for an occurrence of another bill", async () => {
    const { service } = build({ ...paidRow, billSetupId: "someone-else" });
    await expect(
      service.listLinkCandidates(USER_ID, BILL_ID, paidRow.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("semi-monthly materialization", () => {
  it("creates occurrences on the 15th and last business day, starting from the next pay date", async () => {
    const insertOccurrences = vi.fn(async (rows: any[]) =>
      rows.map((row, index) => ({
        ...row,
        id: String(index),
        status: "upcoming",
      })),
    );
    await materializeBillsForUser(USER_ID, BILL_ID, 2, {
      repository: {
        list: async () => [
          {
            id: BILL_ID,
            billType: "payable",
            toAccountId: null,
            userConfirmed: true,
            cadence: "biweekly",
            cadenceOverride: "semimonthly",
            // A stale biweekly date from before the user switched cadence.
            nextExpectedDate: "2026-10-02",
            avgAmount: -662301n,
            accountId: null,
            categoryId: null,
            canonicalName: "Example employer payroll",
          },
        ],
        upsertBillForecastEvents: async () => undefined,
      } as any,
      occurrences: { insertOccurrences, listBySetup: async () => [] } as any,
      withUserMutation: async (_id, callback) => callback({} as any),
      now: () => new Date("2026-09-26T12:00:00Z"),
    });
    expect(
      insertOccurrences.mock.calls.flatMap(([rows]) =>
        rows.map((row: any) => row.dueDate),
      ),
    ).toEqual(["2026-10-15", "2026-10-30", "2026-11-13"]);
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
  const PAY = "88888888-8888-4888-8888-888888888888";
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
    occ(PAY, "2026-10-02"),
    occ(PAY, "2026-10-16"),
    occ(PAY, "2026-10-30"),
  ];
  const service = () =>
    createBillsService({
      repository: {
        list: vi.fn(async () => [
          billRow(VENTURE, "Venture X payment", "2026-09-20"),
          billRow(SAVOR, "Savor payment", "2026-10-01"),
          billRow(TWICE, "Twice monthly", "2026-10-10", "semimonthly"),
          billRow(PAY, "Biweekly pay", "2026-10-02", "biweekly"),
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
                // Earliest per setup, like the real DISTINCT ON ... ORDER BY due date.
                .reverse()
                .map((o) => [o.billSetupId, o]),
            ),
        ),
        allInRangeForSetups: vi.fn(
          async (_u: string, ids: string[], from: string, to: string) => {
            const bySetup = new Map<string, typeof occurrences>();
            for (const o of occurrences.filter(
              (o) =>
                ids.includes(o.billSetupId) &&
                o.status !== "cancelled" &&
                o.dueDate >= from &&
                o.dueDate <= to,
            ))
              bySetup.set(o.billSetupId, [
                ...(bySetup.get(o.billSetupId) ?? []),
                o,
              ]);
            return bySetup;
          },
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
      ["Biweekly pay", "2026-10-02", "upcoming"],
      ["Twice monthly", "2026-10-10", null],
      ["Venture X payment", "2026-10-20", "upcoming"],
    ]);
    await expect(view("2026-11")).resolves.toEqual([
      ["Savor payment", "2026-11-01", "paid"],
      ["Venture X payment", "2026-11-20", "upcoming"],
    ]);
  });

  it("returns every occurrence due in the month, not just the first", async () => {
    const october = await service().listBills(USER_ID, "2026-10");
    const pay = october.series.find(
      (bill) => bill.canonicalName === "Biweekly pay",
    );
    expect(pay?.currentOccurrence?.dueDate).toBe("2026-10-02");
    expect(pay?.monthOccurrences?.map((o) => o.dueDate)).toEqual([
      "2026-10-02",
      "2026-10-16",
      "2026-10-30",
    ]);
    const twice = october.series.find(
      (bill) => bill.canonicalName === "Twice monthly",
    );
    expect(twice?.monthOccurrences).toEqual([]);
  });

  it("does not place a bill in a month by a stale nextExpectedDate once it has occurrences", async () => {
    await expect(view("2026-09")).resolves.toEqual([]);
    await expect(view("2026-12")).resolves.toEqual([]);
  });
});

describe("variable payroll reconciliation", () => {
  async function reconcile(
    options: { deposits?: any[]; setups?: any[]; rows?: any[] } = {},
  ) {
    const row = {
      id: "occurrence",
      billSetupId: BILL_ID,
      dueDate: "2026-10-01",
      dueDateOverride: null,
      expectedAmountCents: -10000n,
      expectedAmountOverrideCents: null,
      status: "upcoming",
    };
    const deposit = {
      id: "deposit",
      accountId: "checking",
      date: "2026-10-01",
      amount: -18000n,
      merchantName: "Employer Inc",
      name: "Payroll",
    };
    const repository = {
      list: vi.fn(
        async () =>
          options.setups ?? [
            {
              id: BILL_ID,
              status: "active",
              isIncome: true,
              userConfirmed: true,
              canonicalName: "employer",
              accountId: "checking",
            },
          ],
      ),
      listIncomeConfirmationTransactions: vi.fn(
        async () => options.deposits ?? [deposit],
      ),
      listAutoConfirmationTransactions: vi.fn(async () => []),
      listRecentRecurringTransactions: vi.fn(async () => []),
      tryClaimAutoConfirmationTransaction: vi.fn(async () => true),
      findById: vi.fn(async () => null),
      applyBillCategoryToTransaction: vi.fn(async () => false),
      resolveBillForecastEvent: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    };
    const occurrences = {
      listAutoConfirmationCandidates: vi.fn(async () => options.rows ?? [row]),
      updateIfStatus: vi.fn(async () => ({ ...row, status: "paid" })),
    };
    await resolveMaturedForecastEvents(USER_ID, {
      repository: repository as any,
      occurrences: occurrences as any,
      withUserMutation: async (_user, callback) => callback({} as any),
    });
    return { repository, occurrences, row, deposit };
  }
  it("records the variable actual deposit and resolves its estimated forecast", async () => {
    const { repository, occurrences } = await reconcile();
    expect(occurrences.updateIfStatus).toHaveBeenCalledWith(
      USER_ID,
      "occurrence",
      expect.anything(),
      expect.objectContaining({
        paidAmountCents: -18000n,
        linkedTransactionId: "deposit",
      }),
      expect.anything(),
    );
    expect(repository.resolveBillForecastEvent).toHaveBeenCalledTimes(1);
  });
  it("does not match a different employer, account, unconfirmed setup, or date", async () => {
    const base = (await reconcile()).deposit;
    for (const deposit of [
      { ...base, merchantName: "Other employer" },
      { ...base, accountId: "other" },
      { ...base, date: "2026-10-20" },
    ])
      expect(
        (await reconcile({ deposits: [deposit] })).occurrences.updateIfStatus,
      ).not.toHaveBeenCalled();
    expect(
      (
        await reconcile({
          setups: [
            {
              id: BILL_ID,
              status: "active",
              isIncome: true,
              userConfirmed: false,
              canonicalName: "employer",
            },
          ],
        })
      ).occurrences.updateIfStatus,
    ).not.toHaveBeenCalled();
  });
  it("leaves ambiguous deposits and overlapping occurrences unresolved", async () => {
    const { deposit, row } = await reconcile();
    expect(
      (await reconcile({ deposits: [deposit, { ...deposit, id: "another" }] }))
        .occurrences.updateIfStatus,
    ).not.toHaveBeenCalled();
    expect(
      (await reconcile({ rows: [row, { ...row, id: "another" }] })).occurrences
        .updateIfStatus,
    ).not.toHaveBeenCalled();
  });
});

describe("income amount mutation signs", () => {
  it("stores manual recurring income as a negative forecast amount", async () => {
    const insertManual = vi.fn(async (_user, input) => ({
      ...input,
      id: BILL_ID,
      avgAmount: input.avgAmount,
      lastAmount: null,
      createdAt: new Date(),
      lastPriceChangeAt: null,
      previousAvgAmount: null,
    }));
    const service = createBillsService({
      repository: { insertManual, recordAudit: async () => undefined } as any,
      billDispatcher: {
        detect: async () => undefined,
        materialize: async () => undefined,
      },
      withUserMutation: async (_id, callback) => callback({} as any),
    });
    await service.createBill(USER_ID, {
      canonicalName: "Employer",
      amountCents: 10000n,
      cadence: "biweekly",
      nextExpectedDate: "2026-10-01",
      isIncome: true,
      billType: "payable",
    });
    expect(insertManual).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ avgAmount: -10000n, isIncome: true }),
      expect.anything(),
    );
  });
  it("preserves the income sign for an editable estimate and prevents marking it as an outflow", async () => {
    const row = {
      id: "occurrence",
      billSetupId: BILL_ID,
      status: "upcoming",
      dueDate: "2026-10-01",
      dueDateOverride: null,
      expectedAmountCents: -10000n,
      expectedAmountOverrideCents: null,
      paidAmountCents: null,
      markedPaidAt: null,
      confirmedPaidAt: null,
      createdAt: new Date(),
    };
    const updateOccurrence = vi.fn(async (_user, _bill, _id, patch) => ({
      ...row,
      ...patch,
    }));
    const updateLinkedForecastEvent = vi.fn(async () => undefined);
    const service = createBillsService({
      repository: { recordAudit: async () => undefined } as any,
      occurrences: {
        findEditableOccurrence: async () => row,
        findById: async () => row,
        updateOccurrence,
        updateLinkedForecastEvent,
      } as any,
      withUserMutation: async (_id, callback) => callback({} as any),
    });
    await service.updateOccurrence(USER_ID, BILL_ID, row.id, {
      amountCents: 14000n,
    });
    expect(updateOccurrence).toHaveBeenCalledWith(
      USER_ID,
      BILL_ID,
      row.id,
      { expectedAmountOverrideCents: -14000n },
      expect.anything(),
    );
    expect(updateLinkedForecastEvent).toHaveBeenCalledWith(
      USER_ID,
      row.id,
      row.dueDate,
      -14000n,
      expect.anything(),
    );
    await expect(
      service.markOccurrencePaid(USER_ID, row.id, {
        accountId: "account",
        amountCents: 14000n,
      }),
    ).rejects.toThrow("Income is confirmed when its deposit arrives");
  });
});

describe("confirmed schedule edit boundaries", () => {
  it("keeps issued card statements bank-owned and rejects an unsupported reset cadence", async () => {
    const base = {
      id: BILL_ID,
      status: "active",
      userConfirmed: true,
      cadence: "monthly",
      cadenceOverride: null,
      billType: "transfer",
      toAccountId: "card",
      avgAmount: 8000n,
      isIncome: false,
    };
    const repository = {
      findById: vi.fn(async () => base),
      findTransferAccount: vi.fn(async () => ({ type: "credit" })),
      update: vi.fn(),
    };
    const service = createBillsService({
      repository: repository as any,
      withUserMutation: async (_id, callback) => callback({} as any),
    });
    await expect(
      service.updateBill(USER_ID, BILL_ID, { amountCents: 9000n }),
    ).rejects.toThrow("come from your bank");
    repository.findById.mockResolvedValue({
      ...base,
      billType: "payable",
      cadence: "irregular",
    });
    await expect(
      service.updateBill(USER_ID, BILL_ID, { cadence: null }),
    ).rejects.toThrow("supported cadence");
    expect(repository.update).not.toHaveBeenCalled();
  });
});
