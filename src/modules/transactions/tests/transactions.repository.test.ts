import { describe, expect, it, vi } from "vitest";

import { toTransactionDto } from "../transactions.mapper.js";
import {
  transactionRepository,
  type TransactionListRow,
} from "../transactions.repository.js";

describe("transactions repository boundary", () => {
  it("recursively serializes raw row audit snapshots before JSONB insertion", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));

    await transactionRepository.recordAudit(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        entityId: "22222222-2222-4222-8222-222222222222",
        source: "transactions.patch",
        before: {
          amount: 1250n,
          updatedAt: new Date("2026-09-04T12:00:00.000Z"),
          nested: [{ amount: -50n }],
        },
        after: { amount: 1300n },
      },
      { insert } as never,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeJson: {
          amount: "1250",
          updatedAt: "2026-09-04T12:00:00.000Z",
          nested: [{ amount: "-50" }],
        },
        afterJson: { amount: "1300" },
      }),
    );
  });

  it("keeps bigint money internal while exposing cents as a wire-safe string", () => {
    const row: TransactionListRow = {
      id: "11111111-1111-4111-8111-111111111111",
      plaidTransactionId: "plaid",
      accountId: "22222222-2222-4222-8222-222222222222",
      amount: 1250n,
      currency: "USD",
      date: "2026-09-04",
      status: "posted",
      name: "Coffee",
      merchantName: null,
      paymentChannel: null,
      plaidCategoryPrimary: null,
      plaidCategoryDetailed: null,
      categoryId: null,
      userCategoryOverride: false,
      isRecurring: false,
      reviewStatus: "needs_review",
      userName: null,
      notes: null,
    };

    expect(toTransactionDto(row)).toMatchObject({
      amount: "1250",
      name: "Coffee",
    });
  });
});
