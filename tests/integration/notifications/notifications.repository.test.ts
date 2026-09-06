import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  auditLog,
  notificationPreferences,
  users,
} from "../../../database/schema/index.js";
import { createNotificationPreferencesRepository } from "../../../src/modules/notifications/notifications.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

guardedDescribe("isolated notification preferences repository", () => {
  it("gets or creates defaults and updates only the owning tenant", async () => {
    const testDb = await createIsolatedTestDatabase();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    try {
      await testDb.db.insert(users).values([
        { id: ownerId, email: `${ownerId}@example.test`, name: "Owner" },
        { id: otherId, email: `${otherId}@example.test`, name: "Other" },
      ]);
      const repository = createNotificationPreferencesRepository(testDb.db);
      const defaults = await repository.getOrCreatePreferences(ownerId);
      expect(defaults).toMatchObject({
        userId: ownerId,
        billRemindersEnabled: true,
        billReminderDaysAhead: 3,
        quietHoursEnabled: true,
        quietHoursStart: 22,
        quietHoursEnd: 7,
      });
      const updated = await repository.updatePreferences(ownerId, {
        billReminderDaysAhead: 5,
        quietHoursEnabled: false,
      });
      expect(updated).toMatchObject({
        userId: ownerId,
        billReminderDaysAhead: 5,
        quietHoursEnabled: false,
      });
      expect(await repository.getOrCreatePreferences(otherId)).toMatchObject({
        userId: otherId,
        billReminderDaysAhead: 3,
      });
      expect(
        await testDb.db
          .select()
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, otherId)),
      ).toHaveLength(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("records a JSON-safe audit row in the same explicit database client", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userId = randomUUID();
    try {
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "Audit User",
      });
      const repository = createNotificationPreferencesRepository(testDb.db);
      const before = await repository.getOrCreatePreferences(userId);
      const after = await repository.updatePreferences(userId, {
        billRemindersEnabled: false,
      });
      await repository.recordAudit?.({
        userId,
        before: {
          billRemindersEnabled: before.billRemindersEnabled,
          billReminderDaysAhead: before.billReminderDaysAhead,
        },
        after: {
          billRemindersEnabled: after.billRemindersEnabled,
          billReminderDaysAhead: after.billReminderDaysAhead,
        },
      });
      const rows = await testDb.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, userId),
            eq(auditLog.entityType, "notification_preferences"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "update",
        source: "notifications.update",
      });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
