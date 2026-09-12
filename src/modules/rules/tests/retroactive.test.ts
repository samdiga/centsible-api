import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { schema } from "../../../platform/database/client.js";
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
  actionRename: null,
  actionHide: null,
  actionAddTagIds: null,
};

const USER_ID = "44444444-4444-4444-8444-444444444444";

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

describe("desiredActionPatch — rename and hide", () => {
  it("sets userName when actionRename is present", () => {
    const withRename: RuleForMatching = { ...rule, actionRename: "Starbucks" };
    expect(desiredActionPatch(withRename)).toMatchObject({
      userName: "Starbucks",
    });
  });

  it("sets reviewStatus to hidden when actionHide is true", () => {
    const withHide: RuleForMatching = { ...rule, actionHide: true };
    expect(desiredActionPatch(withHide)).toMatchObject({
      reviewStatus: "hidden",
    });
  });

  it("does not set reviewStatus when actionHide is false or null", () => {
    const withHideFalse: RuleForMatching = {
      ...rule,
      actionMarkReviewed: null,
      actionHide: false,
    };
    expect(desiredActionPatch(withHideFalse).reviewStatus).toBeUndefined();
  });
});

describe("applyRuleRetroactively — tag insert", () => {
  it("adds tags additively via addTransactionTags, without touching column state", async () => {
    const tagRule: RuleForMatching = {
      ...rule,
      actionCategoryId: null,
      actionAddTagIds: ["tag-1", "tag-2"],
    };
    const addTransactionTags = vi.fn(async () => undefined);
    const txn = {
      merchantName: "Netflix",
      name: "NETFLIX.COM",
      amount: -1599n,
      userId: USER_ID,
      id: "txn-1",
      userCategoryOverride: false,
      deletedAt: null,
    };
    const selectResult = [txn];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(selectResult) }),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([]) }),
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
      }),
    };
    const repository: Pick<
      RuleRepository,
      "findRuleByIdForUpdate" | "incrementTimesApplied" | "recordAudit"
    > = {
      findRuleByIdForUpdate: vi.fn(
        async () =>
          ({
            ...tagRule,
            actionAddTags: tagRule.actionAddTagIds,
            isActive: true,
          }) as unknown as RuleRow,
      ),
      incrementTimesApplied: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    };
    await applyRuleRetroactively(tagRule.id, USER_ID, {
      repository: repository as RuleRepository,
      withUserMutation: async (_userId, callback) =>
        callback(tx as unknown as DbTransaction),
      addTransactionTags,
    });
    expect(addTransactionTags).toHaveBeenCalledWith(
      "txn-1",
      USER_ID,
      ["tag-1", "tag-2"],
      tx,
    );
  });

  it("retroactively applies a tag-only rule (no column actions) instead of short-circuiting", async () => {
    // Regression test: a rule whose ONLY action is actionAddTagIds is a
    // valid, creatable rule (see hasAnyAction in rules.schemas.ts and the
    // merged-action guard in rules.service.ts's updateRule), but
    // desiredActionPatch() has no concept of tag actions — it only models
    // column-patch actions. Previously, applyRuleRetroactively computed
    // `desired = desiredActionPatch(rule)`, found it empty for a tag-only
    // rule, and returned BEFORE ever reaching the batch loop's tag-insert
    // step. This asserts the tag-insert step is still reached.
    const tagOnlyRule: RuleForMatching = {
      id: "11111111-1111-4111-8111-111111111111",
      priority: 1,
      matchType: "merchant_exact",
      matchMerchant: "Netflix",
      matchNameContains: null,
      matchAmountMin: null,
      matchAmountMax: null,
      matchAccountId: null,
      actionCategoryId: null,
      actionMemberId: null,
      actionSetNotes: null,
      actionMarkReviewed: null,
      actionExcludeFromBudgets: null,
      actionRename: null,
      actionHide: null,
      actionAddTagIds: ["tag-1"],
    };
    const addTransactionTags = vi.fn(async () => undefined);
    const txn = {
      merchantName: "Netflix",
      name: "NETFLIX.COM",
      amount: -1599n,
      userId: USER_ID,
      id: "txn-1",
      userCategoryOverride: false,
      deletedAt: null,
    };
    const selectResult = [txn];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(selectResult) }),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([]) }),
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
      }),
    };
    const recordAudit = vi.fn(async () => undefined);
    const repository: Pick<
      RuleRepository,
      "findRuleByIdForUpdate" | "incrementTimesApplied" | "recordAudit"
    > = {
      findRuleByIdForUpdate: vi.fn(
        async () =>
          ({
            ...tagOnlyRule,
            actionAddTags: tagOnlyRule.actionAddTagIds,
            isActive: true,
          }) as unknown as RuleRow,
      ),
      incrementTimesApplied: vi.fn(async () => undefined),
      recordAudit,
    };
    // batch.length (1) < RULE_RETROACTIVE_BATCH_SIZE (200), so the loop
    // terminates after this single batch — no need for a second page.
    await applyRuleRetroactively(tagOnlyRule.id, USER_ID, {
      repository: repository as RuleRepository,
      withUserMutation: async (_userId, callback) =>
        callback(tx as unknown as DbTransaction),
      addTransactionTags,
    });
    expect(addTransactionTags).toHaveBeenCalledWith(
      "txn-1",
      USER_ID,
      ["tag-1"],
      tx,
    );
    expect(recordAudit).toHaveBeenCalled();
  });

  it("the real defaultAddTransactionTags drops a stale tag id instead of inserting it or throwing", async () => {
    // rules.action_add_tags has no FK to tags.id, so a rule can keep
    // referencing a tag long after it's been deleted. transaction_tags.tag_id
    // IS a NOT NULL FK — inserting a stale id would throw and abort the
    // whole transaction. This exercises the real (non-mocked)
    // defaultAddTransactionTags, not an injected stub, to prove the
    // existence filter is actually wired in.
    const tagRule: RuleForMatching = {
      ...rule,
      actionCategoryId: null,
      actionAddTagIds: ["tag-1", "tag-missing"],
    };
    const txn = {
      merchantName: "Netflix",
      name: "NETFLIX.COM",
      amount: -1599n,
      userId: USER_ID,
      id: "txn-1",
      userCategoryOverride: false,
      deletedAt: null,
    };
    const valuesMock = vi.fn(() => ({
      onConflictDoNothing: () => Promise.resolve(),
    }));
    const insertMock = vi.fn(() => ({ values: valuesMock }));
    const tx = {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.tags) {
            return { where: () => Promise.resolve([{ id: "tag-1" }]) };
          }
          return {
            where: () => ({
              orderBy: () => ({ limit: () => Promise.resolve([txn]) }),
            }),
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([]) }),
        }),
      }),
      insert: insertMock,
    };
    const repository: Pick<
      RuleRepository,
      "findRuleByIdForUpdate" | "incrementTimesApplied" | "recordAudit"
    > = {
      findRuleByIdForUpdate: vi.fn(
        async () =>
          ({
            ...tagRule,
            actionAddTags: tagRule.actionAddTagIds,
            isActive: true,
          }) as unknown as RuleRow,
      ),
      incrementTimesApplied: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    };
    await applyRuleRetroactively(tagRule.id, USER_ID, {
      repository: repository as RuleRepository,
      withUserMutation: async (_userId, callback) =>
        callback(tx as unknown as DbTransaction),
      // No addTransactionTags override — exercises the real default.
    });
    expect(insertMock).toHaveBeenCalledOnce();
    expect(valuesMock).toHaveBeenCalledWith([
      { transactionId: "txn-1", tagId: "tag-1" },
    ]);
  });

  it("the real defaultAddTransactionTags scopes the existence check to the rule owner's userId", async () => {
    // Regression coverage: defaultAddTransactionTags previously checked tag
    // existence via inArray(tags.id, ids) alone, with no
    // eq(tags.userId, userId) filter — unlike the properly-scoped
    // tagsExist(). This asserts the compiled WHERE clause against
    // schema.tags actually carries the owner's userId.
    const tagRule: RuleForMatching = {
      ...rule,
      actionCategoryId: null,
      actionAddTagIds: ["tag-1"],
    };
    const txn = {
      merchantName: "Netflix",
      name: "NETFLIX.COM",
      amount: -1599n,
      userId: USER_ID,
      id: "txn-1",
      userCategoryOverride: false,
      deletedAt: null,
    };
    let tagsWhereCondition: unknown;
    const tx = {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.tags) {
            return {
              where: (condition: unknown) => {
                tagsWhereCondition = condition;
                return Promise.resolve([{ id: "tag-1" }]);
              },
            };
          }
          return {
            where: () => ({
              orderBy: () => ({ limit: () => Promise.resolve([txn]) }),
            }),
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([]) }),
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
      }),
    };
    const repository: Pick<
      RuleRepository,
      "findRuleByIdForUpdate" | "incrementTimesApplied" | "recordAudit"
    > = {
      findRuleByIdForUpdate: vi.fn(
        async () =>
          ({
            ...tagRule,
            actionAddTags: tagRule.actionAddTagIds,
            isActive: true,
          }) as unknown as RuleRow,
      ),
      incrementTimesApplied: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    };
    await applyRuleRetroactively(tagRule.id, USER_ID, {
      repository: repository as RuleRepository,
      withUserMutation: async (_userId, callback) =>
        callback(tx as unknown as DbTransaction),
      // No addTransactionTags override — exercises the real default.
    });
    const dialect = new PgDialect();
    const { sql, params } = dialect.sqlToQuery(
      tagsWhereCondition as Parameters<typeof dialect.sqlToQuery>[0],
    );
    expect(sql).toContain("user_id");
    expect(params).toContain(USER_ID);
  });
});
