import { and, asc, eq, ilike, isNull, sql } from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import type { RuleMatchType, UpdateRuleInput } from "./rules.schemas.js";

export type RuleRow = typeof schema.rules.$inferSelect;
export type RuleDb = Db | DbTransaction;
export type RuleData = Readonly<{
  matchType: RuleMatchType;
  matchMerchant: string | null;
  matchNameContains: string | null;
  matchAmountMin: bigint | null;
  matchAmountMax: bigint | null;
  matchAccountId: string | null;
  actionCategoryId: string | null;
  actionMemberId: string | null;
  actionSetNotes: string | null;
  actionMarkReviewed: boolean | null;
  actionExcludeFromBudgets: boolean | null;
  actionRename: string | null;
  actionHide: boolean | null;
  actionAddTags: string[] | null;
  name: string | null;
  priority: number;
  applyToExisting: boolean;
}>;

export type RuleAudit = Readonly<{
  userId: string;
  entityId: string;
  action: "create" | "update" | "delete";
  source: string;
  before?: unknown;
  after?: unknown;
}>;

export type RuleRepository = Readonly<{
  createRule: (userId: string, data: RuleData, db?: RuleDb) => Promise<RuleRow>;
  listRules: (userId: string, db?: RuleDb) => Promise<RuleRow[]>;
  listActiveRules: (userId: string, db?: RuleDb) => Promise<RuleRow[]>;
  findRuleById: (
    id: string,
    userId: string,
    db?: RuleDb,
  ) => Promise<RuleRow | null>;
  findRuleByIdForUpdate: (
    id: string,
    userId: string,
    db: DbTransaction,
  ) => Promise<RuleRow | null>;
  updateRule: (
    id: string,
    userId: string,
    patch: UpdateRuleInput,
    db?: RuleDb,
  ) => Promise<RuleRow | null>;
  deleteRule: (
    id: string,
    userId: string,
    db?: RuleDb,
  ) => Promise<RuleRow | null>;
  incrementTimesApplied: (
    id: string,
    userId: string,
    count: number,
    db?: RuleDb,
  ) => Promise<void>;
  countMatchingTransactions: (
    userId: string,
    matchType: RuleMatchType,
    matchMerchant: string | null,
    db?: RuleDb,
  ) => Promise<number>;
  categoryExists: (
    userId: string,
    categoryId: string,
    db?: RuleDb,
  ) => Promise<boolean>;
  accountExists: (
    userId: string,
    accountId: string,
    db?: RuleDb,
  ) => Promise<boolean>;
  householdMemberExists: (
    userId: string,
    memberId: string,
    db?: RuleDb,
  ) => Promise<boolean>;
  categoryName: (
    userId: string,
    categoryId: string,
    db?: RuleDb,
  ) => Promise<string | null>;
  recordAudit: (audit: RuleAudit, db?: RuleDb) => Promise<void>;
}>;

function safeJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(safeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, safeJson(entry)]),
    );
  }
  return value;
}

export const rulesRepository: RuleRepository = {
  async createRule(userId, data, db = getDb()) {
    const rows = await db
      .insert(schema.rules)
      .values({ userId, ...data, isActive: true })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Rule insert did not return a row");
    return row;
  },

  listRules(userId, db = getDb()) {
    return db
      .select()
      .from(schema.rules)
      .where(eq(schema.rules.userId, userId))
      .orderBy(
        asc(schema.rules.priority),
        asc(schema.rules.createdAt),
        asc(schema.rules.id),
      );
  },

  listActiveRules(userId, db = getDb()) {
    return db
      .select()
      .from(schema.rules)
      .where(
        and(eq(schema.rules.userId, userId), eq(schema.rules.isActive, true)),
      )
      .orderBy(
        asc(schema.rules.priority),
        asc(schema.rules.createdAt),
        asc(schema.rules.id),
      );
  },

  async findRuleById(id, userId, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.rules)
      .where(and(eq(schema.rules.id, id), eq(schema.rules.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  },

  async findRuleByIdForUpdate(id, userId, db) {
    const rows = await db
      .select()
      .from(schema.rules)
      .where(and(eq(schema.rules.id, id), eq(schema.rules.userId, userId)))
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  },

  async updateRule(id, userId, patch, db = getDb()) {
    const rows = await db
      .update(schema.rules)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(schema.rules.id, id), eq(schema.rules.userId, userId)))
      .returning();
    return rows[0] ?? null;
  },

  async deleteRule(id, userId, db = getDb()) {
    const rows = await db
      .delete(schema.rules)
      .where(and(eq(schema.rules.id, id), eq(schema.rules.userId, userId)))
      .returning();
    return rows[0] ?? null;
  },

  async incrementTimesApplied(id, userId, count, db = getDb()) {
    await db
      .update(schema.rules)
      .set({
        timesApplied: sql`${schema.rules.timesApplied} + ${count}`,
        lastAppliedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.rules.id, id), eq(schema.rules.userId, userId)));
  },

  async countMatchingTransactions(
    userId,
    matchType,
    matchMerchant,
    db = getDb(),
  ) {
    if (
      !matchMerchant ||
      !["merchant_exact", "merchant_contains"].includes(matchType)
    )
      return 0;
    const condition =
      matchType === "merchant_exact"
        ? sql`lower(${schema.transactions.merchantName}) = lower(${matchMerchant})`
        : ilike(schema.transactions.merchantName, `%${matchMerchant}%`);
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.userCategoryOverride, false),
          isNull(schema.transactions.deletedAt),
          condition,
        ),
      );
    return rows[0]?.count ?? 0;
  },

  async categoryExists(userId, categoryId, db = getDb()) {
    const rows = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, categoryId),
          isNull(schema.categories.archivedAt),
          sql`(${schema.categories.userId} is null or ${schema.categories.userId} = ${userId})`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  async accountExists(userId, accountId, db = getDb()) {
    const rows = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, accountId),
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  async householdMemberExists(userId, memberId, db = getDb()) {
    const rows = await db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.id, memberId),
          eq(schema.householdMembers.userId, userId),
          isNull(schema.householdMembers.deletedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  async categoryName(userId, categoryId, db = getDb()) {
    const rows = await db
      .select({ name: schema.categories.name })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, categoryId),
          isNull(schema.categories.archivedAt),
          sql`(${schema.categories.userId} is null or ${schema.categories.userId} = ${userId})`,
        ),
      )
      .limit(1);
    return rows[0]?.name ?? null;
  },

  async recordAudit(audit, db = getDb()) {
    await db.insert(schema.auditLog).values({
      userId: audit.userId,
      entityType: "rule",
      entityId: audit.entityId,
      action: audit.action,
      source: audit.source,
      ...(audit.before === undefined
        ? {}
        : { beforeJson: safeJson(audit.before) }),
      ...(audit.after === undefined
        ? {}
        : { afterJson: safeJson(audit.after) }),
    });
  },
};

export function createRulesRepository(db: Db): RuleRepository {
  return {
    createRule: (userId, data, transaction) =>
      rulesRepository.createRule(userId, data, transaction ?? db),
    listRules: (userId, transaction) =>
      rulesRepository.listRules(userId, transaction ?? db),
    listActiveRules: (userId, transaction) =>
      rulesRepository.listActiveRules(userId, transaction ?? db),
    findRuleById: (id, userId, transaction) =>
      rulesRepository.findRuleById(id, userId, transaction ?? db),
    findRuleByIdForUpdate: (id, userId, transaction) =>
      rulesRepository.findRuleByIdForUpdate(id, userId, transaction),
    updateRule: (id, userId, patch, transaction) =>
      rulesRepository.updateRule(id, userId, patch, transaction ?? db),
    deleteRule: (id, userId, transaction) =>
      rulesRepository.deleteRule(id, userId, transaction ?? db),
    incrementTimesApplied: (id, userId, count, transaction) =>
      rulesRepository.incrementTimesApplied(
        id,
        userId,
        count,
        transaction ?? db,
      ),
    countMatchingTransactions: (userId, type, merchant, transaction) =>
      rulesRepository.countMatchingTransactions(
        userId,
        type,
        merchant,
        transaction ?? db,
      ),
    categoryExists: (userId, id, transaction) =>
      rulesRepository.categoryExists(userId, id, transaction ?? db),
    accountExists: (userId, id, transaction) =>
      rulesRepository.accountExists(userId, id, transaction ?? db),
    householdMemberExists: (userId, id, transaction) =>
      rulesRepository.householdMemberExists(userId, id, transaction ?? db),
    categoryName: (userId, id, transaction) =>
      rulesRepository.categoryName(userId, id, transaction ?? db),
    recordAudit: (audit, transaction) =>
      rulesRepository.recordAudit(audit, transaction ?? db),
  };
}
