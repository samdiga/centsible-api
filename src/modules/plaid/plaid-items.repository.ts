import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import type { EncryptedToken } from "./plaid.crypto.js";

export type PlaidItemRow = typeof schema.plaidItems.$inferSelect;
export type PlaidDb = Db | DbTransaction;

export type PlaidItemsRepository = Readonly<{
  listByUser: (userId: string) => Promise<PlaidItemRow[]>;
  findById: (id: string, userId: string) => Promise<PlaidItemRow | null>;
  findByPlaidItemId: (plaidItemId: string) => Promise<PlaidItemRow | null>;
  create: (
    input: {
      userId: string;
      plaidItemId: string;
      institutionId: string;
      institutionName: string;
      accessToken: EncryptedToken;
    },
    db?: PlaidDb,
  ) => Promise<PlaidItemRow>;
  softDelete: (id: string, userId: string, db?: PlaidDb) => Promise<boolean>;
  isFeatureEnabled: (flagKey: string, userId: string) => Promise<boolean>;
  ensureUserSchedule: (userId: string, db?: PlaidDb) => Promise<void>;
  findByUuid: (id: string) => Promise<PlaidItemRow | null>;
  advanceCursor: (
    id: string,
    fromCursor: string | null,
    toCursor: string,
    db?: PlaidDb,
  ) => Promise<boolean>;
  markSynced: (id: string, db?: PlaidDb) => Promise<void>;
  markStatus: (
    id: string,
    status: PlaidItemRow["status"],
    errorCode: string,
    errorMessage: string,
  ) => Promise<void>;
}>;

export function createPlaidItemsRepository(
  db: Db = getDb(),
): PlaidItemsRepository {
  return {
    listByUser(userId) {
      return db
        .select()
        .from(schema.plaidItems)
        .where(
          and(
            eq(schema.plaidItems.userId, userId),
            isNull(schema.plaidItems.deletedAt),
          ),
        )
        .orderBy(schema.plaidItems.createdAt);
    },
    async findById(id, userId) {
      const rows = await db
        .select()
        .from(schema.plaidItems)
        .where(
          and(
            eq(schema.plaidItems.id, id),
            eq(schema.plaidItems.userId, userId),
            isNull(schema.plaidItems.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async findByPlaidItemId(plaidItemId) {
      const rows = await db
        .select()
        .from(schema.plaidItems)
        .where(eq(schema.plaidItems.plaidItemId, plaidItemId))
        .limit(1);
      return rows[0] ?? null;
    },
    async create(input, database = db) {
      const rows = await database
        .insert(schema.plaidItems)
        .values({
          userId: input.userId,
          plaidItemId: input.plaidItemId,
          institutionId: input.institutionId,
          institutionName: input.institutionName,
          accessTokenEncrypted: input.accessToken.encrypted,
          accessTokenNonce: input.accessToken.nonce,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Plaid item insert returned no row");
      return row;
    },
    async softDelete(id, userId, database = db) {
      const rows = await database
        .update(schema.plaidItems)
        .set({
          status: "disconnected",
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.plaidItems.id, id),
            eq(schema.plaidItems.userId, userId),
            isNull(schema.plaidItems.deletedAt),
          ),
        )
        .returning({ id: schema.plaidItems.id });
      return rows.length > 0;
    },
    async isFeatureEnabled(flagKey, userId) {
      const rows = await db
        .select({ enabled: schema.featureFlags.enabled })
        .from(schema.featureFlags)
        .where(
          and(
            eq(schema.featureFlags.flagKey, flagKey),
            or(
              eq(schema.featureFlags.userId, userId),
              isNull(schema.featureFlags.userId),
            ),
          ),
        )
        .orderBy(asc(sql`${schema.featureFlags.userId} IS NULL`))
        .limit(1);
      return rows[0]?.enabled ?? true;
    },
    async ensureUserSchedule(userId, database = db) {
      const users = await database
        .select({ timezone: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      await database
        .insert(schema.syncSchedules)
        .values({
          userId,
          scheduleKey: "daily_sync_pipeline",
          hour: 6,
          minute: 0,
          timezone: users[0]?.timezone ?? "America/Los_Angeles",
          enabled: true,
        })
        .onConflictDoNothing();
    },
    async findByUuid(id) {
      const rows = await db
        .select()
        .from(schema.plaidItems)
        .where(
          and(
            eq(schema.plaidItems.id, id),
            isNull(schema.plaidItems.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async advanceCursor(id, fromCursor, toCursor, database = db) {
      const rows = await database
        .update(schema.plaidItems)
        .set({ cursor: toCursor, updatedAt: new Date() })
        .where(
          and(
            eq(schema.plaidItems.id, id),
            fromCursor === null
              ? isNull(schema.plaidItems.cursor)
              : eq(schema.plaidItems.cursor, fromCursor),
          ),
        )
        .returning({ id: schema.plaidItems.id });
      return rows.length > 0;
    },
    async markSynced(id, database = db) {
      await database
        .update(schema.plaidItems)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.plaidItems.id, id));
    },
    async markStatus(id, status, errorCode, errorMessage) {
      await db
        .update(schema.plaidItems)
        .set({ status, errorCode, errorMessage, updatedAt: new Date() })
        .where(eq(schema.plaidItems.id, id));
    },
  };
}
