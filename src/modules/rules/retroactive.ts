import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

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

export type AddTransactionTags = (
  transactionId: string,
  tagIds: string[],
  tx: DbTransaction,
) => Promise<void>;

export type RetroactiveDependencies = Readonly<{
  repository?: RuleRepository;
  withUserMutation?: UserMutationService["withUserMutation"];
  addTransactionTags?: AddTransactionTags;
}>;

export function ruleForMatching(row: RuleRow): RuleForMatching {
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
    actionRename: row.actionRename,
    actionHide: row.actionHide,
    actionAddTagIds: row.actionAddTags,
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

export type TransactionActionState = Readonly<{
  categoryId: string | null;
  userCategoryOverride: boolean;
  householdMemberId: string | null;
  notes: string | null;
  reviewStatus: "needs_review" | "reviewed" | "hidden";
  excludeFromBudgets: boolean;
  userName: string | null;
}>;

export type DesiredActionPatch = {
  -readonly [Key in keyof TransactionActionState]?: TransactionActionState[Key];
};

export function desiredActionPatch(rule: RuleForMatching): DesiredActionPatch {
  const patch: DesiredActionPatch = {};
  if (rule.actionCategoryId) {
    patch.categoryId = rule.actionCategoryId;
    patch.userCategoryOverride = true;
  }
  if (rule.actionMemberId) patch.householdMemberId = rule.actionMemberId;
  if (rule.actionSetNotes) patch.notes = rule.actionSetNotes;
  if (rule.actionMarkReviewed) patch.reviewStatus = "reviewed";
  if (rule.actionExcludeFromBudgets) patch.excludeFromBudgets = true;
  if (rule.actionRename) patch.userName = rule.actionRename;
  if (rule.actionHide) patch.reviewStatus = "hidden";
  return patch;
}

export function transactionNeedsActionUpdate(
  transaction: Partial<TransactionActionState>,
  patch: DesiredActionPatch,
): boolean {
  return Object.entries(patch).some(
    ([key, expected]) =>
      transaction[key as keyof TransactionActionState] !== expected,
  );
}

function transactionPatch(
  rule: RuleForMatching,
): Partial<typeof schema.transactions.$inferInsert> {
  return { ...desiredActionPatch(rule), updatedAt: new Date() };
}

function actionDifferenceCondition(patch: DesiredActionPatch) {
  const clauses = [
    patch.categoryId === undefined
      ? undefined
      : sql`${schema.transactions.categoryId} is distinct from ${patch.categoryId}`,
    patch.userCategoryOverride === undefined
      ? undefined
      : sql`${schema.transactions.userCategoryOverride} is distinct from ${patch.userCategoryOverride}`,
    patch.householdMemberId === undefined
      ? undefined
      : sql`${schema.transactions.householdMemberId} is distinct from ${patch.householdMemberId}`,
    patch.notes === undefined
      ? undefined
      : sql`${schema.transactions.notes} is distinct from ${patch.notes}`,
    patch.reviewStatus === undefined
      ? undefined
      : sql`${schema.transactions.reviewStatus} is distinct from ${patch.reviewStatus}`,
    patch.excludeFromBudgets === undefined
      ? undefined
      : sql`${schema.transactions.excludeFromBudgets} is distinct from ${patch.excludeFromBudgets}`,
    patch.userName === undefined
      ? undefined
      : sql`${schema.transactions.userName} is distinct from ${patch.userName}`,
  ].filter((clause): clause is ReturnType<typeof sql> => clause !== undefined);
  return clauses.length > 0 ? or(...clauses) : undefined;
}

function defaultMutation() {
  return createWithUserMutation({
    db: getDb(),
    cache: { invalidateUser: () => undefined },
  });
}

async function defaultAddTransactionTags(
  transactionId: string,
  tagIds: string[],
  tx: DbTransaction,
): Promise<void> {
  if (tagIds.length === 0) return;
  const unique = [...new Set(tagIds)];
  await tx
    .insert(schema.transactionTags)
    .values(unique.map((tagId) => ({ transactionId, tagId })))
    .onConflictDoNothing();
}

/** Applies one active rule to eligible transactions in deterministic keyset batches. */
export async function applyRuleRetroactively(
  ruleId: string,
  userId: string,
  dependencies: RetroactiveDependencies = {},
): Promise<void> {
  const repository = dependencies.repository ?? rulesRepository;
  const mutate =
    dependencies.withUserMutation ??
    ((owner, callback) => defaultMutation()(owner, callback));
  const addTags = dependencies.addTransactionTags ?? defaultAddTransactionTags;

  await mutate(userId, async (tx: DbTransaction) => {
    const row = await repository.findRuleByIdForUpdate(ruleId, userId, tx);
    if (!row || !row.isActive) return;
    const rule = ruleForMatching(row);
    const desired = desiredActionPatch(rule);
    if (Object.keys(desired).length === 0) {
      await repository.recordAudit(
        {
          userId,
          entityId: ruleId,
          action: "update",
          source: "rules.retroactive_apply",
          before: { ruleId },
          after: { ruleId, totalApplied: 0 },
        },
        tx,
      );
      return;
    }
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
            matchRules(transactionForMatching(transaction), [rule]) !== null &&
            transactionNeedsActionUpdate(transaction, desired),
        )
        .map((transaction) => transaction.id);
      if (rule.actionAddTagIds && rule.actionAddTagIds.length > 0) {
        const toTag = batch.filter(
          (transaction) =>
            matchRules(transactionForMatching(transaction), [rule]) !== null,
        );
        for (const transaction of toTag) {
          await addTags(transaction.id, rule.actionAddTagIds, tx);
        }
      }
      if (matchingIds.length > 0) {
        const changed = await tx
          .update(schema.transactions)
          .set(transactionPatch(rule))
          .where(
            and(
              inArray(schema.transactions.id, matchingIds),
              eq(schema.transactions.userId, userId),
              eq(schema.transactions.userCategoryOverride, false),
              isNull(schema.transactions.deletedAt),
              actionDifferenceCondition(desired),
            ),
          )
          .returning({ id: schema.transactions.id });
        totalApplied += changed.length;
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
