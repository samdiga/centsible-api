import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import { getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { categoryVisibleTo } from "./category-visibility.js";
import { ConflictError } from "../../platform/errors/app-error.js";
import { isUniqueViolation } from "../../platform/database/unique-violation.js";

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
      parentId: string | null;
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
  /** The user's live subcategories of this category (own and default). */
  listChildren: (
    userId: string,
    parentId: string,
    db?: CategoryDb,
  ) => Promise<CategoryRow[]>;
  /**
   * The user's own live top-level category with this name, other than
   * `exceptId`. Unique indexes treat a null parent as distinct, so the
   * database alone doesn't stop two groups sharing a name.
   */
  findOwnTopLevelByName: (
    userId: string,
    name: string,
    exceptId: string,
    db?: CategoryDb,
  ) => Promise<CategoryRow | null>;
  /** Makes the user's own subcategories of this category top-level groups. */
  promoteChildren: (
    userId: string,
    parentId: string,
    db: CategoryDb,
  ) => Promise<number>;
  /**
   * Points everything of this user's that uses `fromId` at `toId` (null =
   * uncategorised): transactions, rules, bills, goals and forecast events.
   * Plan items merge into the destination's item in the same plan (amounts
   * added), move when it has none, and are dropped when uncategorised.
   */
  moveReferences: (
    userId: string,
    fromId: string,
    toId: string | null,
    db: CategoryDb,
  ) => Promise<{ transactions: number }>;
  recordAudit: (audit: CategoryAudit, db?: CategoryDb) => Promise<void>;
}>;

const visibleToUser = categoryVisibleTo;
/**
 * Writes touch only the caller's own rows. The shared defaults (user_id
 * NULL) are visible to everyone, so changing one would change it for all.
 */
const ownedByUser = (userId: string) => eq(schema.categories.userId, userId);

async function moveCategoryReferences(
  db: CategoryDb,
  userId: string,
  fromId: string,
  toId: string | null,
): Promise<{ transactions: number }> {
  const now = new Date();
  const moved = await db
    .update(schema.transactions)
    .set({ categoryId: toId, updatedAt: now })
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.categoryId, fromId),
      ),
    )
    .returning({ id: schema.transactions.id });
  await db
    .update(schema.rules)
    .set({ actionCategoryId: toId, updatedAt: now })
    .where(
      and(
        eq(schema.rules.userId, userId),
        eq(schema.rules.actionCategoryId, fromId),
      ),
    );
  await db
    .update(schema.billSetup)
    .set({ categoryId: toId, updatedAt: now })
    .where(
      and(
        eq(schema.billSetup.userId, userId),
        eq(schema.billSetup.categoryId, fromId),
      ),
    );
  await db
    .update(schema.goals)
    .set({ linkedCategoryId: toId, updatedAt: now })
    .where(
      and(
        eq(schema.goals.userId, userId),
        eq(schema.goals.linkedCategoryId, fromId),
      ),
    );
  await db
    .update(schema.goals)
    .set({ autoContributeFromCategoryId: toId, updatedAt: now })
    .where(
      and(
        eq(schema.goals.userId, userId),
        eq(schema.goals.autoContributeFromCategoryId, fromId),
      ),
    );
  await db
    .update(schema.forecastEvents)
    .set({ categoryId: toId, updatedAt: now })
    .where(
      and(
        eq(schema.forecastEvents.userId, userId),
        eq(schema.forecastEvents.categoryId, fromId),
      ),
    );
  const items = await db
    .select()
    .from(schema.budgetItems)
    .innerJoin(
      schema.budgets,
      eq(schema.budgets.id, schema.budgetItems.budgetId),
    )
    .where(
      and(
        eq(schema.budgets.userId, userId),
        eq(schema.budgetItems.categoryId, fromId),
      ),
    );
  for (const { budget_items: item } of items) {
    if (toId === null) {
      await db
        .delete(schema.budgetItems)
        .where(eq(schema.budgetItems.id, item.id));
      continue;
    }
    const [target] = await db
      .select()
      .from(schema.budgetItems)
      .where(
        and(
          eq(schema.budgetItems.budgetId, item.budgetId),
          eq(schema.budgetItems.categoryId, toId),
          item.householdMemberId === null
            ? isNull(schema.budgetItems.householdMemberId)
            : eq(schema.budgetItems.householdMemberId, item.householdMemberId),
        ),
      );
    if (target) {
      await db
        .update(schema.budgetItems)
        .set({ amount: target.amount + item.amount, updatedAt: now })
        .where(eq(schema.budgetItems.id, target.id));
      await db
        .delete(schema.budgetItems)
        .where(eq(schema.budgetItems.id, item.id));
    } else {
      await db
        .update(schema.budgetItems)
        .set({ categoryId: toId, updatedAt: now })
        .where(eq(schema.budgetItems.id, item.id));
    }
  }
  return { transactions: moved.length };
}

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
    try {
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
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError("Another category already has this name there");
      throw error;
    }
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
      await moveCategoryReferences(db, userId, id, copy.id);
      const now = new Date();
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
  async listChildren(userId, parentId, db = getDb()) {
    return db
      .select()
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.parentId, parentId),
          visibleToUser(userId),
          isNull(schema.categories.archivedAt),
        ),
      );
  },
  async findOwnTopLevelByName(userId, name, exceptId, db = getDb()) {
    const [row] = await db
      .select()
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.userId, userId),
          isNull(schema.categories.parentId),
          isNull(schema.categories.archivedAt),
          eq(schema.categories.name, name),
          ne(schema.categories.id, exceptId),
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async promoteChildren(userId, parentId, db) {
    try {
      const rows = await db
        .update(schema.categories)
        .set({ parentId: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.categories.userId, userId),
            eq(schema.categories.parentId, parentId),
            isNull(schema.categories.archivedAt),
          ),
        )
        .returning({ id: schema.categories.id });
      return rows.length;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError(
          "A subcategory has the same name as one of your groups; rename it first",
        );
      throw error;
    }
  },
  moveReferences: (userId, fromId, toId, db) =>
    moveCategoryReferences(db, userId, fromId, toId),
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
    listCategories: (userId, transaction) =>
      categoryRepository.listCategories(userId, transaction ?? db),
    getCategoryById: (userId, id, transaction) =>
      categoryRepository.getCategoryById(userId, id, transaction ?? db),
    insertCategory: (userId, data, transaction) =>
      categoryRepository.insertCategory(userId, data, transaction ?? db),
    updateCategory: (userId, id, data, transaction) =>
      categoryRepository.updateCategory(userId, id, data, transaction ?? db),
    archiveCategory: (userId, id, transaction) =>
      categoryRepository.archiveCategory(userId, id, transaction ?? db),
    listChildren: (userId, parentId, transaction) =>
      categoryRepository.listChildren(userId, parentId, transaction ?? db),
    findOwnTopLevelByName: (userId, name, exceptId, transaction) =>
      categoryRepository.findOwnTopLevelByName(
        userId,
        name,
        exceptId,
        transaction ?? db,
      ),
    promoteChildren: (userId, parentId, transaction) =>
      categoryRepository.promoteChildren(userId, parentId, transaction ?? db),
    moveReferences: (userId, fromId, toId, transaction) =>
      categoryRepository.moveReferences(
        userId,
        fromId,
        toId,
        transaction ?? db,
      ),
    customizeDefault: (userId, id, transaction) =>
      categoryRepository.customizeDefault(userId, id, transaction ?? db),
    recordAudit: (audit, transaction) =>
      categoryRepository.recordAudit(audit, transaction ?? db),
  };
}
