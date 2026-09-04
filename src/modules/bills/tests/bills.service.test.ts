/* eslint-disable @typescript-eslint/no-explicit-any -- narrow repository doubles intentionally expose only the methods under test. */
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
} from "../../../platform/errors/app-error.js";
import { createBillsService } from "../bills.service.js";

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
});
