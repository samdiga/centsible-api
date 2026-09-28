import type { ApnsSender } from "../../platform/apns/index.js";
import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import { buildBillReminder } from "./bill-reminder-content.js";
import {
  BILL_REMINDER_NOTIFICATION_TYPE,
  createBillRemindersRepository,
  type BillRemindersRepository,
} from "./bill-reminders.repository.js";
import { nextReminder, shiftOutOfQuiet } from "./bill-schedule.js";
import type { NotificationPreferencesRepository } from "./notifications.repository.js";
import { billReminderPushActive } from "./notifications.service.js";

/** Reminders go out at 9 AM local, moved to the end of quiet hours. */
const REMINDER_HOUR = 9;
/** A reminder more than this late (worker down, backlog) is dropped. */
const STALE_AFTER_MS = 6 * 3_600_000;

export type BillReminderRunResult =
  | "inactive"
  | "deferred"
  | "stale"
  | "already_sent"
  | "nothing_due"
  | "sent"
  | "not_delivered";

export type BillRemindersService = Readonly<{
  runForUser: (
    userId: string,
    localDate: string,
  ) => Promise<BillReminderRunResult>;
  /** Queues each recipient's next reminder(s) at their local send time. */
  scheduleAll: () => Promise<{ users: number; queued: number; failed: number }>;
}>;

export type BillRemindersDependencies = Readonly<{
  repository?: BillRemindersRepository;
  preferences: Pick<
    NotificationPreferencesRepository,
    "getOrCreatePreferences" | "clearPushToken"
  >;
  sender: Pick<ApnsSender, "isEnabled" | "send">;
  /** Enqueues `runForUser(userId, localDate)` to run at `at`. */
  enqueue: (userId: string, localDate: string, at: Date) => Promise<void>;
  transaction?: <T>(callback: (tx: DbTransaction) => Promise<T>) => Promise<T>;
  now?: () => Date;
  logger?: Pick<typeof runtimeLogger, "warn" | "error">;
}>;

/** `YYYY-MM-DD` in a zone. */
export function localDateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/**
 * One bill-reminder push per user per local day, sent by the worker so it
 * arrives even when the app hasn't been opened. Only for users whose device
 * has reported its time zone: until then the server can't know when 9 AM is,
 * and the app's own local reminders cover them.
 */
export function createBillRemindersService(
  dependencies: BillRemindersDependencies,
): BillRemindersService {
  const repository = dependencies.repository ?? createBillRemindersRepository();
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.logger ?? runtimeLogger;
  const transaction =
    dependencies.transaction ??
    (<T>(callback: (tx: DbTransaction) => Promise<T>) =>
      getDb().transaction(callback));

  type Prefs = Awaited<
    ReturnType<
      BillRemindersDependencies["preferences"]["getOrCreatePreferences"]
    >
  >;
  const sendTime = (prefs: Prefs, localDate: string): Date | null => {
    if (!prefs.pushTimeZone) return null;
    const nine = nextReminder({
      dueDate: localDate,
      daysAhead: 0,
      timezone: prefs.pushTimeZone,
      reminderHour: REMINDER_HOUR,
    });
    return nine
      ? shiftOutOfQuiet(nine, {
          quietHoursEnabled: prefs.quietHoursEnabled,
          quietHoursStart: prefs.quietHoursStart,
          quietHoursEnd: prefs.quietHoursEnd,
          timeZone: prefs.pushTimeZone,
        })
      : null;
  };

  const runForUser = async (
    userId: string,
    localDate: string,
  ): Promise<BillReminderRunResult> => {
    const prefs = await dependencies.preferences.getOrCreatePreferences(userId);
    if (!billReminderPushActive(prefs) || !dependencies.sender.isEnabled())
      return "inactive";
    const sendAt = sendTime(prefs, localDate);
    if (!sendAt) return "inactive";
    const at = now();
    // Quiet hours may have moved since this was queued.
    if (at.getTime() < sendAt.getTime()) {
      await dependencies.enqueue(userId, localDate, sendAt);
      return "deferred";
    }
    if (at.getTime() - sendAt.getTime() > STALE_AFTER_MS) return "stale";

    const token = prefs.pushToken!;
    return transaction(async (tx) => {
      const existing = await repository.lockDay(userId, localDate, tx);
      if (existing?.pushSentAt) return "already_sent";
      const content = buildBillReminder({
        localDate,
        daysAhead: prefs.billReminderDaysAhead,
        // Unknown means blurred: never put amounts on a lock screen by default.
        hideAmounts: prefs.pushHideAmounts !== false,
        occurrences: await repository.listUnpaidOccurrences(
          userId,
          addDays(localDate, prefs.billReminderDaysAhead),
          tx,
        ),
        mentioned: await repository.listMentionedOccurrenceIds(userId, tx),
      });
      if (!content) return "nothing_due";
      const reminder = { localDate, ...content };
      const row = existing
        ? (await repository.updateReminder(userId, existing.id, reminder, tx),
          existing)
        : await repository.insertReminder(userId, reminder, tx);

      const result = await dependencies.sender.send({
        deviceToken: token,
        payload: {
          aps: {
            alert: { title: content.title, body: content.body },
            sound: "default",
            "thread-id": "bill-reminders",
          },
          type: BILL_REMINDER_NOTIFICATION_TYPE,
          month: content.month,
        },
        collapseId: `bill-reminder-${localDate}`,
        onInvalidToken: async () => {
          await dependencies.preferences.clearPushToken(userId);
        },
      });
      if (result.outcome === "sent") {
        await repository.markPushSent(userId, row.id, now(), tx);
        return "sent";
      }
      // The row stays unsent, so a retry of this job can still deliver it.
      if (result.outcome !== "disabled")
        log.warn(
          { userId, notificationId: row.id, outcome: result.outcome },
          "bill-reminder push not delivered",
        );
      return "not_delivered";
    });
  };

  return {
    runForUser,
    async scheduleAll() {
      const userIds = await repository.listRecipientIds();
      const at = now();
      let queued = 0;
      let failed = 0;
      for (const userId of userIds) {
        try {
          const prefs =
            await dependencies.preferences.getOrCreatePreferences(userId);
          if (!prefs.pushTimeZone) continue;
          // Today and tomorrow, local: whichever still has its send window
          // ahead. A daily run then never skips a day; a day queued twice is
          // sent once (lockDay).
          const today = localDateIn(at, prefs.pushTimeZone);
          for (const localDate of [today, addDays(today, 1)]) {
            const sendAt = sendTime(prefs, localDate);
            if (!sendAt || at.getTime() - sendAt.getTime() > STALE_AFTER_MS)
              continue;
            await dependencies.enqueue(
              userId,
              localDate,
              sendAt.getTime() > at.getTime() ? sendAt : at,
            );
            queued += 1;
          }
        } catch (error) {
          failed += 1;
          log.error({ userId, error }, "bill reminders could not be queued");
        }
      }
      return { users: userIds.length, queued, failed };
    },
  };
}
