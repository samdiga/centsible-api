import { describe, expect, it, vi } from "vitest";

import { createTransactionService } from "../transactions.service.js";
import type { TransactionRepository } from "../transactions.repository.js";

function repository(): TransactionRepository {
  return {
    upsertFromPlaid: vi.fn(),
    upsertManyFromPlaid: vi.fn(),
    softDeleteByPlaidIds: vi.fn(),
    findByPlaidId: vi.fn(),
    listByUser: vi.fn(),
    findById: vi.fn(),
    updateTransaction: vi.fn(),
    applyRuleMatch: vi.fn(),
    bulkUpdateTransactions: vi.fn(),
    listAllForExport: vi.fn(async () => ({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          date: "2026-09-04",
          name: "=SUM(A1)",
          merchantName: "Joe, Bakery",
          accountId: "22222222-2222-4222-8222-222222222222",
          categoryId: null,
          amount: 1250n,
          currency: "USD",
          reviewStatus: "reviewed" as const,
        },
      ],
      truncated: true,
    })),
    categoryExists: vi.fn(),
    householdMemberExists: vi.fn(),
    recordAudit: vi.fn(),
  };
}

describe("transactions export", () => {
  it("preserves the CSV header, spreadsheet escaping, sign convention, and truncation flag", async () => {
    const service = createTransactionService({ repository: repository() });
    const result = await service.exportTransactionsCsv(
      "33333333-3333-4333-8333-333333333333",
      {},
    );

    expect(result.csv.split("\n")[0]).toBe(
      "Date,Name,Merchant,Account,Category,Amount,Currency,Status",
    );
    expect(result.csv).toContain("'=SUM(A1)");
    expect(result.csv).toContain('"Joe, Bakery"');
    expect(result.csv).toContain("-12.50");
    expect(result.truncated).toBe(true);
  });
});
