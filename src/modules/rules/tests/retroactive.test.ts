import { describe, expect, it, vi } from "vitest";

import type { DbTransaction } from "../../../platform/database/types.js";
import type { RuleForMatching } from "../categorization.js";
import type { RuleRepository, RuleRow } from "../rules.repository.js";
import {
  applyRuleRetroactively,
  desiredActionPatch,
  transactionNeedsActionUpdate,
} from "../retroactive.js";

const rule: RuleForMatching = {
  id: "11111111-1111-4111-8111-111111111111",
  priority: 1,
  matchType: "merchant_exact",
  matchMerchant: "Netflix",
  matchNameContains: null,
  matchAmountMin: null,
  matchAmountMax: null,
  matchAccountId: null,
  actionCategoryId: "22222222-2222-4222-8222-222222222222",
  actionMemberId: "33333333-3333-4333-8333-333333333333",
  actionSetNotes: "streaming",
  actionMarkReviewed: true,
  actionExcludeFromBudgets: true,
};

describe("applyRuleRetroactively", () => {
  it("processes a full batch and remainder, counting only returned changes", async () => {
    const ownerId = "44444444-4444-4444-8444-444444444444";
    const categoryId = "55555555-5555-4555-8555-555555555555";
    const ruleRow = {
      ...rule,
      userId: ownerId,
      name: "Netflix",
      matchMerchant: "Netflix",
      isActive: true,
      applyToExisting: true,
      lastAppliedAt: null,
      timesApplied: 0,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      actionCategoryId: categoryId,
    } as unknown as RuleRow;
    const transaction = (id: string) =>
      ({
        id,
        userId: ownerId,
        accountId: "66666666-6666-4666-8666-666666666666",
        amount: 1599n,
        name: "Netflix subscription",
        merchantName: "Netflix",
        categoryId: null,
        userCategoryOverride: false,
        householdMemberId: null,
        notes: null,
        reviewStatus: "needs_review",
        excludeFromBudgets: false,
        deletedAt: null,
      }) as never;
    const firstBatch = Array.from({ length: 200 }, (_, index) =>
      transaction(
        `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
      ),
    );
    const remainder = [transaction("77777777-7777-4777-8777-000000000201")];
    const batches: never[][] = [firstBatch, remainder, []];
    const whereCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    const returningCounts = [200, 1];
    const tx = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            whereCalls.push(condition);
            return {
              orderBy: () => ({
                limit: async (limit: number) => {
                  expect(limit).toBe(200);
                  return batches.shift() ?? [];
                },
              }),
            };
          },
        }),
      }),
      update: () => ({
        set: (patch: unknown) => ({
          where: (condition: unknown) => ({
            returning: async () => {
              updateCalls.push({ patch, condition });
              return Array.from(
                { length: returningCounts.shift() ?? 0 },
                (_, index) => ({
                  id: `changed-${index}`,
                }),
              );
            },
          }),
        }),
      }),
    } as unknown as DbTransaction;
    const incrementTimesApplied = vi.fn(async () => undefined);
    const audits: unknown[] = [];
    const recordAudit = vi.fn(async (audit: unknown) => {
      audits.push(audit);
    });
    const repository = {
      findRuleByIdForUpdate: vi.fn(async () => ruleRow),
      incrementTimesApplied,
      recordAudit,
    } as unknown as RuleRepository;

    await applyRuleRetroactively(ownerId, ownerId, {
      repository,
      withUserMutation: async <T>(
        _userId: string,
        callback: (transaction: DbTransaction) => Promise<T>,
      ) => callback(tx),
    });

    expect(whereCalls).toHaveLength(2);
    expect(updateCalls).toHaveLength(2);
    expect(incrementTimesApplied).toHaveBeenCalledWith(
      ownerId,
      ownerId,
      201,
      tx,
    );
    expect(audits.at(-1)).toMatchObject({ after: { totalApplied: 201 } });
  });

  it("builds only actionable fields and recognizes an already-applied transaction", () => {
    const patch = desiredActionPatch(rule);
    expect(patch).toEqual({
      categoryId: rule.actionCategoryId,
      userCategoryOverride: true,
      householdMemberId: rule.actionMemberId,
      notes: "streaming",
      reviewStatus: "reviewed",
      excludeFromBudgets: true,
    });
    expect(
      transactionNeedsActionUpdate(
        {
          categoryId: rule.actionCategoryId,
          userCategoryOverride: true,
          householdMemberId: rule.actionMemberId,
          notes: "streaming",
          reviewStatus: "reviewed",
          excludeFromBudgets: true,
        },
        patch,
      ),
    ).toBe(false);
    expect(
      transactionNeedsActionUpdate(
        { categoryId: null, userCategoryOverride: false },
        patch,
      ),
    ).toBe(true);
  });

  it("treats a rule with no actions as a zero-change application", () => {
    expect(
      desiredActionPatch({
        ...rule,
        actionCategoryId: null,
        actionMemberId: null,
        actionSetNotes: null,
        actionMarkReviewed: null,
        actionExcludeFromBudgets: null,
      }),
    ).toEqual({});
  });

  it("does not enter a mutation for a missing rule", async () => {
    const withUserMutation = vi.fn(async (_userId, callback) => callback({}));
    const repository = {
      findRuleByIdForUpdate: vi.fn(async () => null),
    } as never;
    await applyRuleRetroactively(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      { repository, withUserMutation },
    );
    expect(withUserMutation).toHaveBeenCalledTimes(1);
  });
});
