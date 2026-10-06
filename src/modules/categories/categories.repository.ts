import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import { getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { categoryVisibleTo } from "./category-visibility.js";

export type CategoryRow = typeof schema.categories.$inferSelect;
export type CategoryDb = Db | DbTransaction;

export type CategoryAudit = Readonly<{
  userId: string;
  entityId: string;
  action: "create" | "update" | "delete";
  source: string;
  before?: unknown;
  after?: unknown;
}>;

export type CategoryRepository = Readonly<{
  listCategories: (userId: string, db?: CategoryDb) => Promise<CategoryRow[]>;
  getCategoryById: (
    userId: string,
    id: string,
    db?: CategoryDb,
  ) => Promise<CategoryRow | null>;
  insertCategory: (
    userId: string,
    data: {
      name: string;
      icon: string | null;
      color: string | null;
      isIncome: boolean;
      excludeFromBudgets: boolean;
      parentId: string | null;
    },
    db?: CategoryDb,
  ) => Promise<CategoryRow>;
  updateCategory: (
    userId: string,
    id: string,
    data: Partial<{
      name: string;
      icon: string | null;
      color: string | null;
      excludeFromBudgets: boolean;
      displayOrder: number;
    }>,
    db?: CategoryDb,
  ) => Promise<CategoryRow | null>;
  archiveCategory: (
    userId: string,
    id: string,
    db?: CategoryDb,
  ) => Promise<CategoryRow | null>;
  /**
   * The user's own copy of a shared default, made on first use: it takes
   * over this user's transactions, plan items, rules, bills, goals,
   * forecast events and subcategories, and the default is hidden for them.
   * Copying a group copies its default subcategories too, so none is left
   * under a hidden parent. Other users are untouched. Returns the copy, or
   * null when `defaultId` is not a live shared default. Run inside the
   * caller's transaction.
   */
  customizeDefault: (
    userId: string,
    defaultId: string,
    db: CategoryDb,
  ) => Promise<CategoryRow | null>;
  recordAudit: (audit: CategoryAudit, db?: CategoryDb) => Promise<void>;
}>;

const visibleToUser = categoryVisibleTo;
/**
 * Writes touch only the caller's own rows. The shared defaults (user_id
 * NULL) are visible to everyone, so changing one would change it for all.
 */
const ownedByUser = (userId: string) => eq(schema.categories.userId, userId);

export const categoryRepository: CategoryRepository = {
  async listCategories(userId, db = getDb()) {
    return db
      .select()
      .from(schema.categories)
      .where(and(visibleToUser(userId), isNull(schema.categories.archivedAt)))
      .orderBy(schema.categories.displayOrder);
  },

  async getCategoryById(userId, id, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, id),
          visibleToUser(userId),
          isNull(schema.categories.archivedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async insertCategory(userId, data, db = getDb()) {
    const maxRow = await db
      .select({ displayOrder: schema.categories.displayOrder })
      .from(schema.categories)
      .where(visibleToUser(userId))
      .orderBy(desc(schema.categories.displayOrder))
      .limit(1);
    const nextOrder = (maxRow[0]?.displayOrder ?? 0) + 1;
    const rows = await db
      .insert(schema.categories)
      .values({
        userId,
        parentId: data.parentId,
        name: data.name,
        icon: data.icon,
        color: data.color,
        isIncome: data.isIncome,
        excludeFromBudgets: data.excludeFromBudgets,
        displayOrder: nextOrder,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Category insert did not return a row");
    return row;
  },

  async updateCategory(userId, id, data, db = getDb()) {
    const rows = await db
      .update(schema.categories)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(schema.categories.id, id),
          ownedByUser(userId),
          isNull(schema.categories.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  async archiveCategory(userId, id, db = getDb()) {
    const now = new Date();
    const rows = await db
      .update(schema.categories)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.categories.id, id),
          ownedByUser(userId),
          isNull(schema.categories.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  async customizeDefault(userId, defaultId, db) {
    // One copy per user and default, even when two requests race.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`category-override:${userId}`}, 0))`,
    );
    const copyOf = async (id: string) =>
      (
        await db
          .select({ categoryId: schema.categoryOverrides.categoryId })
          .from(schema.categoryOverrides)
          .where(
            and(
              eq(schema.categoryOverrides.userId, userId),
              eq(schema.categoryOverrides.defaultCategoryId, id),
            ),
          )
      )[0]?.categoryId;
    const customize = async (id: string): Promise<CategoryRow | null> => {
      const existing = await copyOf(id);
      if (existing)
        return (
          (
            await db
              .select()
              .from(schema.categories)
              .where(eq(schema.categories.id, existing))
          )[0] ?? null
        );
      const [shared] = await db
        .select()
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.id, id),
            isNull(schema.categories.userId),
            isNull(schema.categories.archivedAt),
          ),
        );
      if (!shared) return null;
      const parentId = shared.parentId
        ? ((await copyOf(shared.parentId)) ?? shared.parentId)
        : null;
      // The user may already have their own category with this name here
      // (names are unique per user and parent): that one becomes the copy.
      const [own] = await db
        .select()
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.userId, userId),
            parentId === null
              ? isNull(schema.categories.parentId)
              : eq(schema.categories.parentId, parentId),
            eq(schema.categories.name, shared.name),
          ),
        );
      const [copy] = own
        ? await db
            .update(schema.categories)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(eq(schema.categories.id, own.id))
            .returning()
        : await db
            .insert(schema.categories)
            .values({
              userId,
              parentId,
              name: shared.name,
              icon: shared.icon,
              color: shared.color,
              isIncome: shared.isIncome,
              isTransfer: shared.isTransfer,
              excludeFromBudgets: shared.excludeFromBudgets,
              displayOrder: shared.displayOrder,
            })
            .returning();
      if (!copy) throw new Error("Category copy did not return a row");
      await db
        .insert(schema.categoryOverrides)
        .values({ userId, defaultCategoryId: id, categoryId: copy.id });
      const now = new Date();
      await db
        .update(schema.transactions)
        .set({ categoryId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.categoryId, id),
          ),
        );
      await db
        .update(schema.rules)
        .set({ actionCategoryId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.rules.userId, userId),
            eq(schema.rules.actionCategoryId, id),
          ),
        );
      await db
        .update(schema.billSetup)
        .set({ categoryId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.billSetup.userId, userId),
            eq(schema.billSetup.categoryId, id),
          ),
        );
      await db
        .update(schema.budgetItems)
        .set({ categoryId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.budgetItems.categoryId, id),
            inArray(
              schema.budgetItems.budgetId,
              db
                .select({ id: schema.budgets.id })
                .from(schema.budgets)
                .where(eq(schema.budgets.userId, userId)),
            ),
          ),
        );
      await db
        .update(schema.goals)
        .set({ linkedCategoryId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.goals.userId, userId),
            eq(schema.goals.linkedCategoryId, id),
          ),
        );
      await db
        .update(schema.goals)
        .set({ autoContributeFromCategoryId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.goals.userId, userId),
            eq(schema.goals.autoContributeFromCategoryId, id),
          ),
        );
      await db
        .update(schema.forecastEvents)
        .set({ categoryId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.forecastEvents.userId, userId),
            eq(schema.forecastEvents.categoryId, id),
          ),
        );
      // The user's own subcategories under this default move to the copy.
      await db
        .update(schema.categories)
        .set({ parentId: copy.id, updatedAt: now })
        .where(
          and(
            eq(schema.categories.userId, userId),
            eq(schema.categories.parentId, id),
          ),
        );
      // A copied group takes its default subcategories with it.
      if (shared.parentId === null) {
        const children = await db
          .select({ id: schema.categories.id })
          .from(schema.categories)
          .where(
            and(
              isNull(schema.categories.userId),
              eq(schema.categories.parentId, id),
              isNull(schema.categories.archivedAt),
            ),
          );
        for (const child of children) await customize(child.id);
      }
      return copy;
    };
    return customize(defaultId);
  },
  async recordAudit(audit, db = getDb()) {
    await auditLogRepository.record(
      {
        userId: audit.userId,
        entityType: "category",
        entityId: audit.entityId,
        action: audit.action,
        source: audit.source,
        before: audit.before,
        after: audit.after,
      },
      db,
    );
  },
};

/** Binds repository reads and writes to an explicitly supplied database client. */
export function createCategoryRepository(db: Db): CategoryRepository {
  return {
    listCategories: (userId) => categoryRepository.listCategories(userId, db),
    getCategoryById: (userId, id) =>
      categoryRepository.getCategoryById(userId, id, db),
    insertCategory: (userId, data, transaction) =>
      categoryRepository.insertCategory(userId, data, transaction ?? db),
    updateCategory: (userId, id, data, transaction) =>
      categoryRepository.updateCategory(userId, id, data, transaction ?? db),
    archiveCategory: (userId, id, transaction) =>
      categoryRepository.archiveCategory(userId, id, transaction ?? db),
    customizeDefault: (userId, id, transaction) =>
      categoryRepository.customizeDefault(userId, id, transaction ?? db),
    recordAudit: (audit, transaction) =>
      categoryRepository.recordAudit(audit, transaction ?? db),
  };
}
