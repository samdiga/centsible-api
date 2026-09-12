import { describe, expect, it, vi } from "vitest";

import type { DbTransaction } from "../../../platform/database/types.js";
import type { UserMutationService } from "../../../platform/cache/user-revisions.repository.js";
import {
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../../platform/errors/app-error.js";
import { createRuleService } from "../rules.service.js";
import type { RuleRepository, RuleRow } from "../rules.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "22222222-2222-4222-8222-222222222222";
const CATEGORY_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_ID = "55555555-5555-4555-8555-555555555555";
const TAG_ID = "66666666-6666-4666-8666-666666666666";

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
  actionRename: null,
  actionHide: null,
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
    findRuleByIdForUpdate: vi.fn(async () => row),
    updateRule: vi.fn(async () => row),
    deleteRule: vi.fn(async () => row),
    incrementTimesApplied: vi.fn(async () => undefined),
    countMatchingTransactions: vi.fn(async () => 3),
    categoryExists: vi.fn(async () => true),
    accountExists: vi.fn(async () => true),
    householdMemberExists: vi.fn(async () => true),
    tagsExist: vi.fn(async () => true),
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
      actionRename: "Groceries",
      actionHide: true,
      actionAddTagIds: [TAG_ID],
      applyToExisting: true,
    });

    expect(created.retroactiveJobId).toBe(RULE_ID);
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchRetroactive).toHaveBeenCalledWith(
      RULE_ID,
      USER_ID,
    );
    expect(repo.createRule).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        actionRename: "Groceries",
        actionHide: true,
        actionAddTags: [TAG_ID],
      }),
      expect.anything(),
    );
    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ source: "rules.create" }),
      expect.anything(),
    );
  });

  it("fails before mutation when retroactive application has no dispatcher", async () => {
    const repo = repository();
    const mutationSpy = vi.fn();
    const mutate: UserMutationService["withUserMutation"] = async <T>() => {
      mutationSpy();
      return row as T;
    };
    const service = createRuleService({
      repository: repo,
      withUserMutation: mutate,
    });

    await expect(
      service.createRule(USER_ID, {
        matchType: "merchant_exact",
        matchMerchant: "Whole Foods",
        actionCategoryId: CATEGORY_ID,
        applyToExisting: true,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(mutationSpy).not.toHaveBeenCalled();
    expect(repo.createRule).not.toHaveBeenCalled();
  });

  it("returns the committed rule when dispatch fails and logs once", async () => {
    const repo = repository();
    const dispatcher = {
      dispatchRetroactive: vi.fn(async () => {
        throw new Error("worker unavailable");
      }),
    };
    const logger = { error: vi.fn() };
    let mutations = 0;
    const service = createRuleService({
      repository: repo,
      dispatcher,
      logger,
      withUserMutation: async (_userId, callback) => {
        mutations += 1;
        return callback({} as DbTransaction);
      },
    });

    const result = await service.createRule(USER_ID, {
      matchType: "merchant_exact",
      matchMerchant: "Whole Foods",
      actionCategoryId: CATEGORY_ID,
      applyToExisting: true,
    });
    expect(result.retroactiveJobId).toBeNull();
    expect(result.rule.id).toBe(RULE_ID);
    expect(mutations).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
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

  it("uses the supplied shared response cache for list reads", async () => {
    const cacheCalls: unknown[] = [];
    const cache = {
      getOrCompute: async <T>(key: unknown, compute: () => Promise<T>) => {
        cacheCalls.push(key);
        return compute();
      },
      invalidateUser: vi.fn(),
    };
    const service = createRuleService({
      repository: repository(),
      cache,
      getUserRevision: async () => 7n,
    });
    await service.listRules(USER_ID);
    expect(cacheCalls[0]).toMatchObject({ route: "/rules", revision: 7n });
  });
});

describe("createRule — tag validation", () => {
  it("rejects a nonexistent tag id", async () => {
    const repo = repository();
    vi.mocked(repo.tagsExist).mockResolvedValue(false);
    const service = createRuleService({
      repository: repo,
      withUserMutation: async (_userId, callback) =>
        callback({} as DbTransaction),
    });
    await expect(
      service.createRule(USER_ID, {
        matchType: "merchant_exact",
        matchMerchant: "Whole Foods",
        actionCategoryId: null,
        actionAddTagIds: ["nonexistent-tag"],
        applyToExisting: false,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("updateRule — merged-action check", () => {
  it("rejects an update that would leave the rule with zero actions", async () => {
    const repo = repository();
    vi.mocked(repo.findRuleByIdForUpdate).mockResolvedValue({
      ...row,
      actionCategoryId: null,
      actionMemberId: null,
      actionSetNotes: null,
      actionMarkReviewed: null,
      actionExcludeFromBudgets: null,
      actionRename: null,
      actionHide: null,
      actionAddTags: null,
    });
    const service = createRuleService({
      repository: repo,
      withUserMutation: async (_userId, callback) =>
        callback({} as DbTransaction),
    });
    await expect(
      service.updateRule(USER_ID, RULE_ID, { name: "Renamed rule only" }),
    ).rejects.toThrow(ValidationError);
  });

  it("allows an update that only touches isActive, leaving existing actions untouched", async () => {
    const repo = repository();
    const service = createRuleService({
      repository: repo,
      withUserMutation: async (_userId, callback) =>
        callback({} as DbTransaction),
    });
    await expect(
      service.updateRule(USER_ID, RULE_ID, { isActive: false }),
    ).resolves.toBeDefined();
  });
});

describe("applyRetroactively", () => {
  it("dispatches the retroactive job for an existing rule", async () => {
    const repo = repository();
    const dispatchRetroactive = vi.fn(async () => ({ id: "job-1" }));
    const service = createRuleService({
      repository: repo,
      dispatcher: { dispatchRetroactive },
    });
    const result = await service.applyRetroactively(USER_ID, RULE_ID);
    expect(result).toEqual({ jobId: "job-1" });
    expect(dispatchRetroactive).toHaveBeenCalledWith(RULE_ID, USER_ID);
  });

  it("throws NotFoundError for a rule that doesn't exist", async () => {
    const repo = repository();
    vi.mocked(repo.findRuleById).mockResolvedValue(null);
    const service = createRuleService({
      repository: repo,
      dispatcher: { dispatchRetroactive: vi.fn() },
    });
    await expect(
      service.applyRetroactively(USER_ID, "missing-id"),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ServiceUnavailableError when no dispatcher is configured", async () => {
    const repo = repository();
    const service = createRuleService({ repository: repo });
    await expect(service.applyRetroactively(USER_ID, RULE_ID)).rejects.toThrow(
      ServiceUnavailableError,
    );
  });
});
