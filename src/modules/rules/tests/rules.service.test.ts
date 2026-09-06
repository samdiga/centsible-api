import { describe, expect, it, vi } from "vitest";

import type { DbTransaction } from "../../../platform/database/types.js";
import type { UserMutationService } from "../../../platform/cache/user-revisions.repository.js";
import { ValidationError } from "../../../platform/errors/app-error.js";
import { createRuleService } from "../rules.service.js";
import type { RuleRepository, RuleRow } from "../rules.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "22222222-2222-4222-8222-222222222222";
const CATEGORY_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_ID = "55555555-5555-4555-8555-555555555555";

const row: RuleRow = {
  id: RULE_ID,
  userId: USER_ID,
  name: "Whole Foods",
  priority: 10,
  matchType: "merchant_exact",
  matchMerchant: "Whole Foods",
  matchNameContains: null,
  matchAmountMin: -500n,
  matchAmountMax: 10000n,
  matchAccountId: ACCOUNT_ID,
  actionCategoryId: CATEGORY_ID,
  actionMemberId: MEMBER_ID,
  actionSetNotes: "groceries",
  actionAddTags: null,
  actionMarkReviewed: true,
  actionExcludeFromBudgets: false,
  isActive: true,
  applyToExisting: true,
  lastAppliedAt: null,
  timesApplied: 2,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

function repository(): RuleRepository {
  return {
    createRule: vi.fn(async () => row),
    listRules: vi.fn(async () => [row]),
    listActiveRules: vi.fn(async () => [row]),
    findRuleById: vi.fn(async () => row),
    updateRule: vi.fn(async () => row),
    deleteRule: vi.fn(async () => row),
    incrementTimesApplied: vi.fn(async () => undefined),
    countMatchingTransactions: vi.fn(async () => 3),
    categoryExists: vi.fn(async () => true),
    accountExists: vi.fn(async () => true),
    householdMemberExists: vi.fn(async () => true),
    categoryName: vi.fn(async () => "Groceries"),
    recordAudit: vi.fn(async () => undefined),
  };
}

describe("rules service", () => {
  it("creates through one user mutation and dispatches a retroactive job after commit", async () => {
    const repo = repository();
    const dispatcher = {
      dispatchRetroactive: vi.fn(async () => ({ id: RULE_ID })),
    };
    const mutationSpy = vi.fn();
    const withUserMutation: UserMutationService["withUserMutation"] = async <T>(
      _userId: string,
      callback: (tx: DbTransaction) => Promise<T>,
    ) => {
      mutationSpy();
      return callback({} as DbTransaction);
    };
    const service = createRuleService({
      repository: repo,
      dispatcher,
      withUserMutation,
    });

    const created = await service.createRule(USER_ID, {
      matchType: "merchant_exact",
      matchMerchant: "Whole Foods",
      actionCategoryId: CATEGORY_ID,
      actionMemberId: MEMBER_ID,
      matchAccountId: ACCOUNT_ID,
      matchAmountMin: "-500",
      applyToExisting: true,
    });

    expect(created.retroactiveJobId).toBe(RULE_ID);
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchRetroactive).toHaveBeenCalledWith(
      RULE_ID,
      USER_ID,
    );
    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ source: "rules.create" }),
      expect.anything(),
    );
  });

  it("checks every patched reference inside the mutation transaction", async () => {
    const repo = repository();
    vi.mocked(repo.householdMemberExists).mockResolvedValue(false);
    const service = createRuleService({
      repository: repo,
      withUserMutation: async (_userId, callback) =>
        callback({} as DbTransaction),
    });

    await expect(
      service.updateRule(USER_ID, RULE_ID, { actionMemberId: MEMBER_ID }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repo.householdMemberExists).toHaveBeenCalledWith(
      USER_ID,
      MEMBER_ID,
      expect.anything(),
    );
    expect(repo.accountExists).not.toHaveBeenCalled();
  });

  it("maps persistence bigint and dates to the wire DTO", async () => {
    const service = createRuleService({
      repository: repository(),
      getUserRevision: async () => 0n,
      withUserMutation: async (_userId, callback) =>
        callback({} as DbTransaction),
    });
    const rules = await service.listRules(USER_ID);
    expect(rules[0]).toMatchObject({
      matchAmountMin: "-500",
      matchAmountMax: "10000",
    });
    expect(JSON.stringify(rules)).not.toContain("-500n");
  });
});
