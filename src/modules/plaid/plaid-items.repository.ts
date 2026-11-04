import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import type { EncryptedToken } from "./plaid.crypto.js";

export type PlaidItemRow = typeof schema.plaidItems.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
export type PlaidDb = Db | DbTransaction;

export type PlaidItemsRepository = Readonly<{
  listByUser: (userId: string) => Promise<PlaidItemRow[]>;
  findById: (id: string, userId: string) => Promise<PlaidItemRow | null>;
  findByPlaidItemId: (plaidItemId: string) => Promise<PlaidItemRow | null>;
  /**
   * The user's live bank accounts on a live connection to `institutionId`
   * with one of these mask + type + subtype triples: the same account linked
   * again. A removed account doesn't count; relinking takes that over.
   */
  findLiveAccountMatches: (
    userId: string,
    institutionId: string,
    accounts: ReadonlyArray<{
      mask: string;
      type: AccountRow["type"];
      /** Null matches any subtype. */
      subtype: AccountRow["subtype"] | null;
    }>,
  ) => Promise<
    Array<{
      itemId: string;
      institutionName: string | null;
      accountId: string;
      name: string;
      mask: string | null;
    }>
  >;
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
  markBankUpdated: (id: string, at: Date | null, db?: PlaidDb) => Promise<void>;
  markStatus: (
    id: string,
    status: PlaidItemRow["status"],
    errorCode: string | null,
    errorMessage: string | null,
    db?: PlaidDb,
  ) => Promise<void>;
  markWebhookStatus: (
    id: string,
    status: PlaidItemRow["status"],
    errorCode: string | null,
    errorMessage: string | null,
    db?: PlaidDb,
  ) => Promise<void>;
  /** Whether the connection has a live credit card or loan account. */
  hasLiabilityAccounts: (id: string, userId: string) => Promise<boolean>;
  /** Records what the bank will share, ending any run of failed fetches. */
  setLiabilitiesStatus: (
    id: string,
    userId: string,
    status: NonNullable<PlaidItemRow["liabilitiesStatus"]>,
    db?: PlaidDb,
  ) => Promise<void>;
  /**
   * Counts a fetch that failed without saying why. `clearConsent` forgets a
   * stale `consent_required` once Plaid says Liabilities is consented.
   */
  recordLiabilitiesFailure: (
    id: string,
    userId: string,
    options: Readonly<{ clearConsent: boolean }>,
    db?: PlaidDb,
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
    async findLiveAccountMatches(userId, institutionId, accounts) {
      if (!accounts.length) return [];
      return db
        .select({
          itemId: schema.plaidItems.id,
          institutionName: schema.plaidItems.institutionName,
          accountId: schema.accounts.id,
          name: sql<string>`coalesce(${schema.accounts.nameOverride}, ${schema.accounts.name})`,
          mask: schema.accounts.mask,
        })
        .from(schema.accounts)
        .innerJoin(
          schema.plaidItems,
          eq(schema.plaidItems.id, schema.accounts.plaidItemId),
        )
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.plaidItems.userId, userId),
            isNull(schema.accounts.deletedAt),
            isNull(schema.plaidItems.deletedAt),
            eq(schema.plaidItems.institutionId, institutionId),
            or(
              ...accounts.map((account) =>
                and(
                  eq(schema.accounts.mask, account.mask),
                  eq(schema.accounts.type, account.type),
                  account.subtype === null
                    ? undefined
                    : eq(schema.accounts.subtype, account.subtype),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(schema.plaidItems.createdAt), asc(schema.accounts.id));
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
    async markBankUpdated(id, at, database = db) {
      await database
        .update(schema.plaidItems)
        .set({ bankLastUpdatedAt: at, updatedAt: new Date() })
        .where(eq(schema.plaidItems.id, id));
    },
    async hasLiabilityAccounts(id, userId) {
      const rows = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.plaidItemId, id),
            eq(schema.accounts.userId, userId),
            isNull(schema.accounts.deletedAt),
            inArray(schema.accounts.type, ["credit", "loan"]),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async setLiabilitiesStatus(id, userId, status, database = db) {
      await database
        .update(schema.plaidItems)
        .set({
          liabilitiesStatus: status,
          liabilitiesFailures: 0,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.plaidItems.id, id),
            eq(schema.plaidItems.userId, userId),
            or(
              sql`${schema.plaidItems.liabilitiesStatus} IS DISTINCT FROM ${status}`,
              ne(schema.plaidItems.liabilitiesFailures, 0),
            ),
          ),
        );
    },
    async recordLiabilitiesFailure(id, userId, { clearConsent }, database = db) {
      await database
        .update(schema.plaidItems)
        .set({
          liabilitiesFailures: sql`${schema.plaidItems.liabilitiesFailures} + 1`,
          ...(clearConsent
            ? {
                liabilitiesStatus: sql`CASE WHEN ${schema.plaidItems.liabilitiesStatus} = 'consent_required' THEN NULL ELSE ${schema.plaidItems.liabilitiesStatus} END`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.plaidItems.id, id),
            eq(schema.plaidItems.userId, userId),
          ),
        );
    },
    async markStatus(id, status, errorCode, errorMessage, database = db) {
      await database
        .update(schema.plaidItems)
        .set({
          status,
          errorCode,
          errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(schema.plaidItems.id, id));
    },
    async markWebhookStatus(
      id,
      status,
      errorCode,
      errorMessage,
      database = db,
    ) {
      await database
        .update(schema.plaidItems)
        .set({
          status,
          errorCode,
          errorMessage,
          lastWebhookAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.plaidItems.id, id));
    },
  };
}
