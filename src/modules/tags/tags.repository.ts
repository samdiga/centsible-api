import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { ConflictError } from "../../platform/errors/app-error.js";

export type TagRow = typeof schema.tags.$inferSelect;
export type TagDb = Db | DbTransaction;

export type TagAudit = Readonly<{
  userId: string;
  entityId: string;
  action: "create" | "update" | "delete";
  source: string;
  before?: unknown;
  after?: unknown;
}>;

export type TagRepository = Readonly<{
  listTags: (userId: string, db?: TagDb) => Promise<TagRow[]>;
  getTagById: (userId: string, id: string, db?: TagDb) => Promise<TagRow | null>;
  /** True when every id in `tagIds` exists and belongs to `userId`. Vacuously true for an empty array. */
  tagsExist: (userId: string, tagIds: string[], db?: TagDb) => Promise<boolean>;
  insertTag: (
    userId: string,
    data: { name: string; color: string | null },
    db?: TagDb,
  ) => Promise<TagRow>;
  updateTag: (
    userId: string,
    id: string,
    data: Partial<{ name: string; color: string | null }>,
    db?: TagDb,
  ) => Promise<TagRow | null>;
  deleteTag: (userId: string, id: string, db?: TagDb) => Promise<boolean>;
  recordAudit: (audit: TagAudit, db?: TagDb) => Promise<void>;
}>;

/**
 * Detects a Postgres unique-violation (SQLSTATE 23505) even when drizzle-orm
 * wraps the underlying `pg` error in a `DrizzleQueryError` (whose own keys
 * are `query`/`params`/`cause`, not `code`). Walks the `.cause` chain up to
 * 8 levels deep, with cycle detection, so it matches the real error's
 * `.code` wherever it ends up nested.
 */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

export const tagRepository: TagRepository = {
  async listTags(userId, db = getDb()) {
    return db
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.userId, userId))
      .orderBy(asc(sql`lower(${schema.tags.name})`));
  },

  async getTagById(userId, id, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.tags)
      .where(and(eq(schema.tags.id, id), eq(schema.tags.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  },

  async tagsExist(userId, tagIds, db = getDb()) {
    if (tagIds.length === 0) return true;
    const unique = [...new Set(tagIds)];
    const rows = await db
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(and(inArray(schema.tags.id, unique), eq(schema.tags.userId, userId)));
    return rows.length === unique.length;
  },

  async insertTag(userId, data, db = getDb()) {
    try {
      const rows = await db
        .insert(schema.tags)
        .values({ userId, name: data.name, color: data.color })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Tag insert did not return a row");
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A tag named "${data.name}" already exists.`);
      }
      throw error;
    }
  },

  async updateTag(userId, id, data, db = getDb()) {
    try {
      const rows = await db
        .update(schema.tags)
        .set(data)
        .where(and(eq(schema.tags.id, id), eq(schema.tags.userId, userId)))
        .returning();
      return rows[0] ?? null;
    } catch (error) {
      if (isUniqueViolation(error) && data.name !== undefined) {
        throw new ConflictError(`A tag named "${data.name}" already exists.`);
      }
      throw error;
    }
  },

  async deleteTag(userId, id, db = getDb()) {
    const rows = await db
      .delete(schema.tags)
      .where(and(eq(schema.tags.id, id), eq(schema.tags.userId, userId)))
      .returning({ id: schema.tags.id });
    return rows.length > 0;
  },

  async recordAudit(audit, db = getDb()) {
    await auditLogRepository.record(
      {
        userId: audit.userId,
        entityType: "tag",
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
export function createTagRepository(db: Db): TagRepository {
  return {
    listTags: (userId) => tagRepository.listTags(userId, db),
    getTagById: (userId, id) => tagRepository.getTagById(userId, id, db),
    tagsExist: (userId, ids) => tagRepository.tagsExist(userId, ids, db),
    insertTag: (userId, data, tx) => tagRepository.insertTag(userId, data, tx ?? db),
    updateTag: (userId, id, data, tx) =>
      tagRepository.updateTag(userId, id, data, tx ?? db),
    deleteTag: (userId, id, tx) => tagRepository.deleteTag(userId, id, tx ?? db),
    recordAudit: (audit, tx) => tagRepository.recordAudit(audit, tx ?? db),
  };
}
