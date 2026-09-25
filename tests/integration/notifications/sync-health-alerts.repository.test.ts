import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  plaidItems,
  syncSchedules,
  users,
} from "../../../database/schema/index.js";
import { createSyncHealthAlertsRepository } from "../../../src/modules/notifications/sync-health-alerts.repository.js";
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

const item = (userId: string, overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  userId,
  plaidItemId: `item-${randomUUID()}`,
  institutionId: "ins_1",
  institutionName: "Chase",
  accessTokenEncrypted: "encrypted",
  accessTokenNonce: "nonce",
  ...overrides,
});

guardedDescribe("isolated sync-health alerts repository", () => {
  it("tracks one open alert per item per tenant until resolved", async () => {
    const testDb = await createIsolatedTestDatabase();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    try {
      await testDb.db.insert(users).values([
        { id: ownerId, email: `${ownerId}@example.test`, name: "Owner" },
        { id: otherId, email: `${otherId}@example.test`, name: "Other" },
      ]);
      const live = item(ownerId, { status: "login_required" });
      const unlinked = item(ownerId, { deletedAt: new Date() });
      const others = item(otherId);
      await testDb.db.insert(plaidItems).values([live, unlinked, others]);
      await testDb.db.insert(syncSchedules).values({
        userId: ownerId,
        scheduleKey: "daily_sync_pipeline",
        timezone: "America/Los_Angeles",
      });
      const repository = createSyncHealthAlertsRepository(testDb.db);

      expect((await repository.listUserIdsWithItems()).sort()).toEqual(
        [ownerId, otherId].sort(),
      );
      expect(await repository.listItems(ownerId)).toEqual([
        expect.objectContaining({ id: live.id, status: "login_required" }),
      ]);
      expect(await repository.userTimeZone(ownerId)).toBe(
        "America/Los_Angeles",
      );
      expect(await repository.userTimeZone(otherId)).toBeNull();

      const alert = await repository.insertAlert(ownerId, {
        plaidItemId: live.id,
        health: "needs_relink",
        title: "Connection needs attention",
        body: "Chase needs you to sign in again.",
      });
      await repository.insertAlert(otherId, {
        plaidItemId: others.id,
        health: "stale",
        title: "t",
        body: "b",
      });
      expect(await repository.listOpenAlerts(ownerId)).toEqual([
        {
          id: alert.id,
          plaidItemId: live.id,
          title: "Connection needs attention",
          body: "Chase needs you to sign in again.",
          pushSentAt: null,
        },
      ]);

      const sentAt = new Date("2026-09-25T18:00:00.000Z");
      await repository.markPushSent(ownerId, alert.id, sentAt);
      expect((await repository.listOpenAlerts(ownerId))[0]?.pushSentAt).toEqual(
        sentAt,
      );

      // Resolving is tenant- and item-scoped, and idempotent.
      expect(await repository.resolveAlerts(otherId, live.id, sentAt)).toBe(0);
      expect(await repository.resolveAlerts(ownerId, live.id, sentAt)).toBe(1);
      expect(await repository.resolveAlerts(ownerId, live.id, sentAt)).toBe(0);
      expect(await repository.listOpenAlerts(ownerId)).toEqual([]);
      expect(await repository.listOpenAlerts(otherId)).toHaveLength(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
