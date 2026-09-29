import { and, eq, inArray } from "drizzle-orm";

import { schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

/**
 * Tags for already tenant-scoped pending transaction IDs. The joins repeat the
 * user filter so a malformed cross-tenant tag link cannot leak another user's
 * tag ID into the forecast response.
 */
export async function getForecastEventTagIds(
  db: Db | DbTransaction,
  userId: string,
  transactionIds: string[],
): Promise<Map<string, string[]>> {
  if (transactionIds.length === 0) return new Map();
  const rows = await db
    .select({
      transactionId: schema.transactionTags.transactionId,
      tagId: schema.transactionTags.tagId,
    })
    .from(schema.transactionTags)
    .innerJoin(
      schema.transactions,
      eq(schema.transactionTags.transactionId, schema.transactions.id),
    )
    .innerJoin(schema.tags, eq(schema.transactionTags.tagId, schema.tags.id))
    .where(
      and(
        inArray(schema.transactionTags.transactionId, transactionIds),
        eq(schema.transactions.userId, userId),
        eq(schema.tags.userId, userId),
      ),
    );
  const byTransaction = new Map<string, string[]>();
  for (const row of rows) {
    const current = byTransaction.get(row.transactionId) ?? [];
    current.push(row.tagId);
    byTransaction.set(row.transactionId, current);
  }
  for (const tags of byTransaction.values()) tags.sort();
  return byTransaction;
}
