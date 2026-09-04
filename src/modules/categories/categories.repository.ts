import { and, desc, eq, isNull, or } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import { getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

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
  recordAudit?: (audit: CategoryAudit, db?: CategoryDb) => Promise<void>;
}>;

const visibleToUser = (userId: string) =>
  or(isNull(schema.categories.userId), eq(schema.categories.userId, userId));

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
          visibleToUser(userId),
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
          visibleToUser(userId),
          isNull(schema.categories.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  async recordAudit(audit, db = getDb()) {
    await db.insert(schema.auditLog).values({
      userId: audit.userId,
      entityType: "category",
      entityId: audit.entityId,
      action: audit.action,
      source: audit.source,
      ...(audit.before === undefined ? {} : { beforeJson: audit.before }),
      ...(audit.after === undefined ? {} : { afterJson: audit.after }),
    });
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
    recordAudit: (audit, transaction) =>
      categoryRepository.recordAudit?.(audit, transaction ?? db) ??
      Promise.resolve(),
  };
}
