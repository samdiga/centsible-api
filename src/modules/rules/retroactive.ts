import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { getDb, schema } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  matchRules,
  type RuleForMatching,
  type TransactionForMatching,
} from "./categorization.js";
import {
  rulesRepository,
  type RuleRepository,
  type RuleRow,
} from "./rules.repository.js";

export const RULE_RETROACTIVE_BATCH_SIZE = 200;

export type RetroactiveDependencies = Readonly<{
  repository?: RuleRepository;
  withUserMutation?: UserMutationService["withUserMutation"];
}>;

function ruleForMatching(row: RuleRow): RuleForMatching {
  return {
    id: row.id,
    priority: row.priority,
    matchType: row.matchType,
    matchMerchant: row.matchMerchant,
    matchNameContains: row.matchNameContains,
    matchAmountMin: row.matchAmountMin,
    matchAmountMax: row.matchAmountMax,
    matchAccountId: row.matchAccountId,
    actionCategoryId: row.actionCategoryId,
    actionMemberId: row.actionMemberId,
    actionSetNotes: row.actionSetNotes,
    actionMarkReviewed: row.actionMarkReviewed,
    actionExcludeFromBudgets: row.actionExcludeFromBudgets,
  };
}

function transactionForMatching(
  row: typeof schema.transactions.$inferSelect,
): TransactionForMatching {
  return {
    merchantName: row.merchantName,
    name: row.name,
    amount: row.amount,
    accountId: row.accountId,
  };
}

function transactionPatch(
  rule: RuleForMatching,
): Partial<typeof schema.transactions.$inferInsert> {
  const patch: Partial<typeof schema.transactions.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (rule.actionCategoryId) {
    patch.categoryId = rule.actionCategoryId;
    patch.userCategoryOverride = true;
  }
  if (rule.actionMemberId) patch.householdMemberId = rule.actionMemberId;
  if (rule.actionSetNotes) patch.notes = rule.actionSetNotes;
  if (rule.actionMarkReviewed) patch.reviewStatus = "reviewed";
  if (rule.actionExcludeFromBudgets) patch.excludeFromBudgets = true;
  return patch;
}

function defaultMutation() {
  return createWithUserMutation({
    db: getDb(),
    cache: { invalidateUser: () => undefined },
  });
}

/** Applies one active rule to eligible transactions in deterministic keyset batches. */
export async function applyRuleRetroactively(
  ruleId: string,
  userId: string,
  dependencies: RetroactiveDependencies = {},
): Promise<void> {
  const repository = dependencies.repository ?? rulesRepository;
  const row = await repository.findRuleById(ruleId, userId);
  if (!row || !row.isActive) return;
  const rule = ruleForMatching(row);
  const mutate =
    dependencies.withUserMutation ??
    ((owner, callback) => defaultMutation()(owner, callback));

  await mutate(userId, async (tx: DbTransaction) => {
    let lastId: string | null = null;
    let totalApplied = 0;
    for (;;) {
      const batch = await tx
        .select()
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.userCategoryOverride, false),
            isNull(schema.transactions.deletedAt),
            lastId ? gt(schema.transactions.id, lastId) : undefined,
          ),
        )
        .orderBy(asc(schema.transactions.id))
        .limit(RULE_RETROACTIVE_BATCH_SIZE);
      if (batch.length === 0) break;
      lastId = batch[batch.length - 1]!.id;
      const matchingIds = batch
        .filter(
          (transaction) =>
            matchRules(transactionForMatching(transaction), [rule]) !== null,
        )
        .map((transaction) => transaction.id);
      if (matchingIds.length > 0) {
        await tx
          .update(schema.transactions)
          .set(transactionPatch(rule))
          .where(
            and(
              inArray(schema.transactions.id, matchingIds),
              eq(schema.transactions.userId, userId),
            ),
          );
        totalApplied += matchingIds.length;
      }
      if (batch.length < RULE_RETROACTIVE_BATCH_SIZE) break;
    }
    if (totalApplied > 0)
      await repository.incrementTimesApplied(ruleId, userId, totalApplied, tx);
    await repository.recordAudit(
      {
        userId,
        entityId: ruleId,
        action: "update",
        source: "rules.retroactive_apply",
        before: { ruleId },
        after: { ruleId, totalApplied },
      },
      tx,
    );
  });
}
