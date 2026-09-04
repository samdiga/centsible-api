import { describe, expect, it } from "vitest";

import { toTransactionDto } from "../transactions.mapper.js";
import type { TransactionListRow } from "../transactions.repository.js";

describe("transactions repository boundary", () => {
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
