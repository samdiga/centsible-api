import { eq } from "drizzle-orm";

import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

export type NotificationPreferencesRow =
  typeof schema.notificationPreferences.$inferSelect;
export type NotificationPreferencesDb = Db | DbTransaction;
export type NotificationPreferencesInput = Partial<{
  billRemindersEnabled: boolean | undefined;
  billReminderDaysAhead: number | undefined;
  quietHoursEnabled: boolean | undefined;
  quietHoursStart: number | undefined;
  quietHoursEnd: number | undefined;
}>;
export type NotificationPreferencesAudit = Readonly<{
  userId: string;
  before: unknown;
  after: unknown;
}>;

export type NotificationPreferencesRepository = Readonly<{
  getOrCreatePreferences: (
    userId: string,
    db?: NotificationPreferencesDb,
  ) => Promise<NotificationPreferencesRow>;
  updatePreferences: (
    userId: string,
    data: NotificationPreferencesInput,
    db?: NotificationPreferencesDb,
  ) => Promise<NotificationPreferencesRow>;
  recordAudit: (
    audit: NotificationPreferencesAudit,
    db?: NotificationPreferencesDb,
  ) => Promise<void>;
}>;

export const notificationPreferencesRepository: NotificationPreferencesRepository =
  {
    async getOrCreatePreferences(userId, db = getDb()) {
      const rows = await db
        .select()
        .from(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, userId))
        .limit(1);
      if (rows[0]) return rows[0];

      const inserted = await db
        .insert(schema.notificationPreferences)
        .values({ userId })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return inserted[0];

      const again = await db
        .select()
        .from(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, userId))
        .limit(1);
      const row = again[0];
      if (!row)
        throw new Error("Notification preference upsert did not return a row");
      return row;
    },

    async updatePreferences(userId, data, db = getDb()) {
      await notificationPreferencesRepository.getOrCreatePreferences(
        userId,
        db,
      );
      const rows = await db
        .update(schema.notificationPreferences)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.notificationPreferences.userId, userId))
        .returning();
      const row = rows[0];
      if (!row)
        throw new Error("Notification preference update did not return a row");
      return row;
    },

    async recordAudit(audit, db = getDb()) {
      await db.insert(schema.auditLog).values({
        userId: audit.userId,
        entityType: "notification_preferences",
        entityId: audit.userId,
        action: "update",
        source: "notifications.update",
        beforeJson: audit.before,
        afterJson: audit.after,
      });
    },
  };

export function createNotificationPreferencesRepository(
  db: Db,
): NotificationPreferencesRepository {
  return {
    getOrCreatePreferences: (userId) =>
      notificationPreferencesRepository.getOrCreatePreferences(userId, db),
    updatePreferences: (userId, data, transaction) =>
      notificationPreferencesRepository.updatePreferences(
        userId,
        data,
        transaction ?? db,
      ),
    recordAudit: (audit, transaction) =>
      notificationPreferencesRepository.recordAudit(audit, transaction ?? db),
  };
}

export const notificationRepository = notificationPreferencesRepository;
