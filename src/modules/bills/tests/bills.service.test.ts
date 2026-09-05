/* eslint-disable @typescript-eslint/no-explicit-any -- narrow repository doubles intentionally expose only the methods under test. */
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
} from "../../../platform/errors/app-error.js";
import {
  createBillWorkerLifecycle,
  createBillsService,
  runOverdueSweep,
  resolveMaturedForecastEvents,
} from "../bills.service.js";
import type { BillsRepository } from "../bills.repository.js";
import type { BillOccurrencesRepository } from "../bill-occurrences.repository.js";

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
      dispatcher: {
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
    const upsertForecastEvents = vi.fn(async () => undefined);
    const insertOccurrences = vi.fn(async () => undefined);
    const lifecycle = createBillWorkerLifecycle({
      repository: {
        list: vi.fn(async () => [bill]),
        upsertForecastEvents,
        detectionTransactions: vi.fn(async () => []),
        upsertDetected: vi.fn(async () => undefined),
        updateDetection: vi.fn(async () => undefined),
        listRecentRecurringTransactions: vi.fn(async () => []),
        listOpenForecastEvents: vi.fn(async () => []),
        resolveForecastEvent: vi.fn(async () => undefined),
      } as any,
      occurrences: {
        insertOccurrences,
        findProcessing: vi.fn(async () => null),
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
    expect(upsertForecastEvents).toHaveBeenCalledTimes(1);
    expect(insertOccurrences).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ dueDate: "2026-09-01" }),
        expect.objectContaining({ dueDate: "2026-11-01" }),
      ]),
      expect.anything(),
    );
  });
});
