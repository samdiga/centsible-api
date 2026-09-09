import { lt, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

type PlaidDb = Db | DbTransaction;

export type PlaidRawImportsRepository = Readonly<{
  record: (
    input: {
      userId: string;
      plaidItemId: string;
      endpoint: string;
      cursor?: string;
      payload: Record<string, unknown>;
    },
    db?: PlaidDb,
  ) => Promise<void>;
  purgeOlderThanDays: (days: number) => Promise<number>;
}>;

export function createPlaidRawImportsRepository(
  db: Db = getDb(),
): PlaidRawImportsRepository {
  return {
    async record(input, database = db) {
      await database.insert(schema.plaidRawImports).values({
        userId: input.userId,
        plaidItemId: input.plaidItemId,
        endpoint: input.endpoint,
        cursor: input.cursor ?? null,
        payload: input.payload,
      });
    },
    async purgeOlderThanDays(days) {
      const rows = await db
        .delete(schema.plaidRawImports)
        .where(
          lt(
            schema.plaidRawImports.createdAt,
            sql`now() - (${days} || ' days')::interval`,
          ),
        )
        .returning({ id: schema.plaidRawImports.id });
      return rows.length;
    },
  };
}
