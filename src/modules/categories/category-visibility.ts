import { and, eq, isNull, or, sql } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";

/**
 * The categories a user sees: their own, and the shared defaults they have
 * not replaced with a copy of their own (category_overrides). Every read
 * that lists or accepts a category uses this, so a replaced default never
 * appears beside the user's copy or wins a match by name.
 */
export const categoryVisibleTo = (userId: string) =>
  or(
    eq(schema.categories.userId, userId),
    and(
      isNull(schema.categories.userId),
      sql`NOT EXISTS (SELECT 1 FROM ${schema.categoryOverrides} WHERE ${schema.categoryOverrides.userId} = ${userId} AND ${schema.categoryOverrides.defaultCategoryId} = ${schema.categories.id})`,
    ),
  )!;
