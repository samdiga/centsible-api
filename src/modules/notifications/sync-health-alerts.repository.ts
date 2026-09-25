import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db } from "../../platform/database/types.js";
import type { PlaidItemRow } from "../plaid/plaid-items.repository.js";

export const SYNC_HEALTH_NOTIFICATION_TYPE = "sync_health";

export type SyncHealthItem = Pick<
  PlaidItemRow,
  "id" | "institutionName" | "status" | "cursor" | "lastSyncAt"
>;

/** An alert stays open until its connection is healthy again (`payload.resolvedAt`). */
export type OpenSyncHealthAlert = Readonly<{
  id: string;
  plaidItemId: string;
  title: string;
  body: string;
  pushSentAt: Date | null;
}>;

export type NewSyncHealthAlert = Readonly<{
  plaidItemId: string;
  health: string;
  title: string;
  body: string;
}>;

export type SyncHealthAlertsRepository = Readonly<{
  listUserIdsWithItems: () => Promise<string[]>;
  listItems: (userId: string) => Promise<SyncHealthItem[]>;
  listOpenAlerts: (userId: string) => Promise<OpenSyncHealthAlert[]>;
  insertAlert: (
    userId: string,
    alert: NewSyncHealthAlert,
  ) => Promise<OpenSyncHealthAlert>;
  resolveAlerts: (
    userId: string,
    plaidItemId: string,
    resolvedAt: Date,
  ) => Promise<number>;
  markPushSent: (userId: string, id: string, sentAt: Date) => Promise<void>;
  userTimeZone: (userId: string) => Promise<string | null>;
}>;

const openAlertFilter = (userId: string) =>
  and(
    eq(schema.notifications.userId, userId),
    eq(schema.notifications.type, SYNC_HEALTH_NOTIFICATION_TYPE),
    sql`${schema.notifications.payload}->>'resolvedAt' is null`,
  );

export function createSyncHealthAlertsRepository(
  db: Db = getDb(),
): SyncHealthAlertsRepository {
  return {
    async listUserIdsWithItems() {
      const rows = await db
        .selectDistinct({ userId: schema.plaidItems.userId })
        .from(schema.plaidItems)
        .where(isNull(schema.plaidItems.deletedAt));
      return rows.map((row) => row.userId);
    },

    listItems(userId) {
      return db
        .select({
          id: schema.plaidItems.id,
          institutionName: schema.plaidItems.institutionName,
          status: schema.plaidItems.status,
          cursor: schema.plaidItems.cursor,
          lastSyncAt: schema.plaidItems.lastSyncAt,
        })
        .from(schema.plaidItems)
        .where(
          and(
            eq(schema.plaidItems.userId, userId),
            isNull(schema.plaidItems.deletedAt),
          ),
        );
    },

    async listOpenAlerts(userId) {
      const rows = await db
        .select({
          id: schema.notifications.id,
          payload: schema.notifications.payload,
          title: schema.notifications.title,
          body: schema.notifications.body,
          pushSentAt: schema.notifications.pushSentAt,
        })
        .from(schema.notifications)
        .where(openAlertFilter(userId))
        .orderBy(schema.notifications.createdAt);
      return rows.flatMap((row) => {
        const itemId = (row.payload as { plaidItemId?: unknown } | null)
          ?.plaidItemId;
        return typeof itemId === "string"
          ? [
              {
                id: row.id,
                plaidItemId: itemId,
                title: row.title,
                body: row.body,
                pushSentAt: row.pushSentAt,
              },
            ]
          : [];
      });
    },

    async insertAlert(userId, alert) {
      const rows = await db
        .insert(schema.notifications)
        .values({
          userId,
          type: SYNC_HEALTH_NOTIFICATION_TYPE,
          title: alert.title,
          body: alert.body,
          payload: { plaidItemId: alert.plaidItemId, health: alert.health },
          sentAt: new Date(),
        })
        .returning({
          id: schema.notifications.id,
          title: schema.notifications.title,
          body: schema.notifications.body,
          pushSentAt: schema.notifications.pushSentAt,
        });
      const row = rows[0];
      if (!row)
        throw new Error("Sync-health notification insert returned no row");
      return { ...row, plaidItemId: alert.plaidItemId };
    },

    async resolveAlerts(userId, plaidItemId, resolvedAt) {
      const rows = await db
        .update(schema.notifications)
        .set({
          payload: sql`coalesce(${schema.notifications.payload}, '{}'::jsonb) || jsonb_build_object('resolvedAt', ${resolvedAt.toISOString()}::text)`,
        })
        .where(
          and(
            openAlertFilter(userId),
            sql`${schema.notifications.payload}->>'plaidItemId' = ${plaidItemId}`,
          ),
        )
        .returning({ id: schema.notifications.id });
      return rows.length;
    },

    async markPushSent(userId, id, sentAt) {
      await db
        .update(schema.notifications)
        .set({ pushSentAt: sentAt })
        .where(
          and(
            eq(schema.notifications.id, id),
            eq(schema.notifications.userId, userId),
          ),
        );
    },

    async userTimeZone(userId) {
      const rows = await db
        .select({ timezone: schema.syncSchedules.timezone })
        .from(schema.syncSchedules)
        .where(
          and(
            eq(schema.syncSchedules.userId, userId),
            eq(schema.syncSchedules.scheduleKey, "daily_sync_pipeline"),
          ),
        )
        .limit(1);
      return rows[0]?.timezone ?? null;
    },
  };
}
