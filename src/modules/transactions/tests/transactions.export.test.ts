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
          accountName: "Chase Checking",
          categoryName: "Groceries",
          tagNames: "Business,Reimbursable",
          amount: 1250n,
          currency: "USD",
          reviewStatus: "reviewed" as const,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          date: "2026-09-03",
          name: "Uncategorized purchase",
          merchantName: null,
          accountName: "Chase Checking",
          categoryName: null,
          tagNames: null,
          amount: 500n,
          currency: "USD",
          reviewStatus: "needs_review" as const,
        },
      ],
      truncated: true,
    })),
    categoryExists: vi.fn(),
    householdMemberExists: vi.fn(),
    tagsExist: vi.fn(),
    getTagIdsForTransactions: vi.fn(),
    replaceTransactionTags: vi.fn(),
    replaceTransactionTagsForMany: vi.fn(),
    addTransactionTags: vi.fn(),
    recordAudit: vi.fn(),
  };
}

describe("transactions export", () => {
  it("emits real account/category names and a tags column, preserving CSV escaping, sign convention, and truncation flag", async () => {
    const service = createTransactionService({ repository: repository() });
    const result = await service.exportTransactionsCsv(
      "33333333-3333-4333-8333-333333333333",
      {},
    );

    const lines = result.csv.split("\n");
    expect(lines[0]).toBe(
      "Date,Name,Merchant,Account,Category,Tags,Amount,Currency,Status",
    );
    expect(lines[1]).toBe(
      '2026-09-04,\'=SUM(A1),"Joe, Bakery",Chase Checking,Groceries,"Business,Reimbursable",-12.50,USD,reviewed',
    );
    expect(lines[2]).toBe(
      "2026-09-03,Uncategorized purchase,,Chase Checking,,,-5.00,USD,needs_review",
    );
    expect(result.csv).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(result.truncated).toBe(true);
  });
});
