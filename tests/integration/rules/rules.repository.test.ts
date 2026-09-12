import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  rules,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createRulesRepository } from "../../../src/modules/rules/rules.repository.js";
import { applyRuleRetroactively } from "../../../src/modules/rules/retroactive.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

guardedDescribe("isolated rules repository", () => {
  it("keeps list and reference lookups tenant-scoped with deterministic ties", async () => {
    const testDb = await createIsolatedTestDatabase();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    try {
      await testDb.db.insert(users).values([
        { id: ownerId, email: `${ownerId}@example.test` },
        { id: otherId, email: `${otherId}@example.test` },
      ]);
      const repository = createRulesRepository(testDb.db);
      const first = await repository.createRule(ownerId, {
        matchType: "merchant_exact",
        matchMerchant: "A",
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
        actionAddTags: null,
        name: "first",
        priority: 10,
        applyToExisting: false,
      });
      const second = await repository.createRule(ownerId, {
        matchType: "merchant_exact",
        matchMerchant: "B",
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
        actionAddTags: null,
        name: "second",
        priority: 10,
        applyToExisting: false,
      });
      await repository.createRule(otherId, {
        matchType: "merchant_exact",
        matchMerchant: "C",
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
        actionAddTags: null,
        name: "other",
        priority: 1,
        applyToExisting: false,
      });
      const listed = await repository.listRules(ownerId);
      expect(new Set(listed.map((value) => value.id))).toEqual(
        new Set([first.id, second.id]),
      );
      expect(
        (await repository.listRules(ownerId)).map((value) => value.id),
      ).toEqual(listed.map((value) => value.id));
      expect(await repository.findRuleById(second.id, otherId)).toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("applies retroactive rules in 200-row batches without crossing tenants or overrides", async () => {
    const testDb = await createIsolatedTestDatabase();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const ownerAccountId = randomUUID();
    const otherAccountId = randomUUID();
    const categoryId = randomUUID();
    try {
      await testDb.db.insert(users).values([
        { id: ownerId, email: `${ownerId}@example.test` },
        { id: otherId, email: `${otherId}@example.test` },
      ]);
      await testDb.db.insert(accounts).values([
        {
          id: ownerAccountId,
          userId: ownerId,
          name: "Checking",
          type: "depository",
          subtype: "checking",
        },
        {
          id: otherAccountId,
          userId: otherId,
          name: "Checking",
          type: "depository",
          subtype: "checking",
        },
      ]);
      await testDb.db
        .insert(categories)
        .values({ id: categoryId, userId: ownerId, name: "Streaming" });
      const repository = createRulesRepository(testDb.db);
      const rule = await repository.createRule(ownerId, {
        matchType: "merchant_exact",
        matchMerchant: "NETFLIX",
        matchNameContains: null,
        matchAmountMin: null,
        matchAmountMax: null,
        matchAccountId: null,
        actionCategoryId: categoryId,
        actionMemberId: null,
        actionSetNotes: null,
        actionMarkReviewed: null,
        actionExcludeFromBudgets: null,
        actionRename: null,
        actionHide: null,
        actionAddTags: null,
        name: "Streaming",
        priority: 100,
        applyToExisting: true,
      });
      await testDb.db.insert(transactions).values(
        Array.from({ length: 450 }, (_, index) => ({
          userId: ownerId,
          accountId: ownerAccountId,
          amount: 1599n,
          date: "2026-06-01",
          status: "posted" as const,
          name: `Netflix ${index}`,
          merchantName: "NETFLIX",
        })),
      );
      await testDb.db.insert(transactions).values([
        {
          userId: ownerId,
          accountId: ownerAccountId,
          amount: 1n,
          date: "2026-06-01",
          status: "posted",
          name: "Netflix override",
          merchantName: "NETFLIX",
          userCategoryOverride: true,
        },
        {
          userId: otherId,
          accountId: otherAccountId,
          amount: 1n,
          date: "2026-06-01",
          status: "posted",
          name: "Netflix other",
          merchantName: "NETFLIX",
        },
      ]);
      await applyRuleRetroactively(rule.id, ownerId, {
        repository,
        withUserMutation: (userId, callback) => testDb.db.transaction(callback),
      });
      await applyRuleRetroactively(rule.id, ownerId, {
        repository,
        withUserMutation: (userId, callback) => testDb.db.transaction(callback),
      });
      const updated = await testDb.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, ownerId),
            eq(transactions.categoryId, categoryId),
          ),
        );
      expect(updated).toHaveLength(450);
      const [updatedRule] = await testDb.db
        .select()
        .from(rules)
        .where(eq(rules.id, rule.id));
      expect(updatedRule?.timesApplied).toBe(450);
      expect(
        await testDb.db
          .select()
          .from(transactions)
          .where(eq(transactions.userId, otherId)),
      ).toHaveLength(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
