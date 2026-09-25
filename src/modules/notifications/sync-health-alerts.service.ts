import type { ApnsSender } from "../../platform/apns/index.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import { computeItemHealth } from "../plaid/plaid-health.js";
import type { PlaidItemHealth } from "../plaid/plaid.schemas.js";
import { shiftOutOfQuiet } from "./bill-schedule.js";
import type { NotificationPreferencesRepository } from "./notifications.repository.js";
import {
  createSyncHealthAlertsRepository,
  SYNC_HEALTH_NOTIFICATION_TYPE,
  type OpenSyncHealthAlert,
  type SyncHealthAlertsRepository,
} from "./sync-health-alerts.repository.js";

/** Used when a user has no daily sync schedule to take a time zone from. */
const FALLBACK_TIME_ZONE = "America/New_York";

export type SyncHealthRunResult = Readonly<{
  created: number;
  resolved: number;
  pushed: number;
  deferredUntil: Date | null;
}>;

export type SyncHealthAlertsService = Readonly<{
  runForUser: (userId: string) => Promise<SyncHealthRunResult>;
  runForAllUsers: () => Promise<{ users: number; failed: number }>;
}>;

export type SyncHealthAlertsDependencies = Readonly<{
  repository?: SyncHealthAlertsRepository;
  preferences: Pick<
    NotificationPreferencesRepository,
    "getOrCreatePreferences" | "clearPushToken"
  >;
  sender: Pick<ApnsSender, "isEnabled" | "send">;
  /** Re-runs this user's alerts at `at` (end of quiet hours). */
  deferRun: (userId: string, at: Date) => Promise<void>;
  now?: () => Date;
  logger?: Pick<typeof runtimeLogger, "warn" | "error">;
}>;

type AlertHealth = Exclude<PlaidItemHealth, "ok">;

const ALERT_COPY: Record<AlertHealth, (institution: string) => string> = {
  needs_relink: (institution) =>
    `${institution} needs you to sign in again so your accounts keep updating.`,
  expiring: (institution) =>
    `Your ${institution} connection expires soon. Reconnect to keep your accounts updating.`,
  error: (institution) =>
    `${institution} stopped updating. Open Connected accounts to fix it.`,
  stale: (institution) => `${institution} hasn't updated in over 3 days.`,
};

function validTimeZone(zone: string | null): string {
  if (!zone) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return zone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/**
 * One alert per connection per unhealthy episode: an item entering
 * needs_relink, expiring, error or stale gets one notification row, and no
 * further alert until it has been healthy again. Pushes go out only when sync
 * alerts are on and a device token exists; inside quiet hours they wait for
 * the end of the window instead of being dropped.
 */
export function createSyncHealthAlertsService(
  dependencies: SyncHealthAlertsDependencies,
): SyncHealthAlertsService {
  const repository =
    dependencies.repository ?? createSyncHealthAlertsRepository();
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.logger ?? runtimeLogger;

  const reconcile = async (userId: string, at: Date) => {
    const [items, open] = await Promise.all([
      repository.listItems(userId),
      repository.listOpenAlerts(userId),
    ]);
    const openByItem = new Set(open.map((alert) => alert.plaidItemId));
    const healthy = new Set<string>();
    let created = 0;
    let resolved = 0;
    const pending: OpenSyncHealthAlert[] = open.filter((a) => !a.pushSentAt);
    for (const item of items) {
      const health = computeItemHealth(item, at);
      if (health === "ok") {
        healthy.add(item.id);
        if (openByItem.has(item.id))
          resolved += await repository.resolveAlerts(userId, item.id, at);
        continue;
      }
      if (openByItem.has(item.id)) continue;
      const alert = await repository.insertAlert(userId, {
        plaidItemId: item.id,
        health,
        title: "Connection needs attention",
        body: ALERT_COPY[health](item.institutionName),
      });
      created += 1;
      pending.push(alert);
    }
    // An open alert whose connection is gone (unlinked) or healthy again must
    // not be pushed.
    const liveIds = new Set(items.map((item) => item.id));
    return {
      created,
      resolved,
      pending: pending.filter(
        (alert) =>
          liveIds.has(alert.plaidItemId) && !healthy.has(alert.plaidItemId),
      ),
    };
  };

  const push = async (
    userId: string,
    token: string,
    alerts: OpenSyncHealthAlert[],
  ) => {
    let pushed = 0;
    for (const alert of alerts) {
      let tokenInvalid = false;
      const result = await dependencies.sender.send({
        deviceToken: token,
        payload: {
          aps: {
            alert: { title: alert.title, body: alert.body },
            sound: "default",
          },
          type: SYNC_HEALTH_NOTIFICATION_TYPE,
          plaidItemId: alert.plaidItemId,
        },
        collapseId: `sync-health-${alert.plaidItemId}`,
        onInvalidToken: async () => {
          tokenInvalid = true;
          await dependencies.preferences.clearPushToken(userId);
        },
      });
      if (result.outcome === "sent") {
        await repository.markPushSent(userId, alert.id, now());
        pushed += 1;
        continue;
      }
      if (tokenInvalid) break;
      if (result.outcome !== "disabled")
        log.warn(
          { userId, notificationId: alert.id, outcome: result.outcome },
          "sync-health push not delivered; will retry on the next run",
        );
    }
    return pushed;
  };

  const runForUser = async (userId: string): Promise<SyncHealthRunResult> => {
    const at = now();
    const prefs = await dependencies.preferences.getOrCreatePreferences(userId);
    if (!prefs.syncAlertsEnabled)
      return { created: 0, resolved: 0, pushed: 0, deferredUntil: null };

    const { created, resolved, pending } = await reconcile(userId, at);
    const token = prefs.pushToken;
    if (!pending.length || !token || !dependencies.sender.isEnabled())
      return { created, resolved, pushed: 0, deferredUntil: null };

    const timeZone = validTimeZone(await repository.userTimeZone(userId));
    const sendAt = shiftOutOfQuiet(at, {
      quietHoursEnabled: prefs.quietHoursEnabled,
      quietHoursStart: prefs.quietHoursStart,
      quietHoursEnd: prefs.quietHoursEnd,
      timeZone,
    });
    if (sendAt && sendAt.getTime() > at.getTime()) {
      await dependencies.deferRun(userId, sendAt);
      return { created, resolved, pushed: 0, deferredUntil: sendAt };
    }
    const pushed = await push(userId, token, pending);
    return { created, resolved, pushed, deferredUntil: null };
  };

  return {
    runForUser,
    async runForAllUsers() {
      const userIds = await repository.listUserIdsWithItems();
      let failed = 0;
      for (const userId of userIds) {
        try {
          await runForUser(userId);
        } catch (error) {
          failed += 1;
          log.error({ userId, error }, "sync-health alerts failed for user");
        }
      }
      return { users: userIds.length, failed };
    },
  };
}
