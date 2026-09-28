import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import {
  billDisplayName,
  type MentionedOccurrences,
  type ReminderOccurrence,
} from "./bill-reminder-content.js";

export const BILL_REMINDER_NOTIFICATION_TYPE = "bill_reminder";

type ReminderDb = Db | DbTransaction;

/** One row per user per local day; `payload.localDate` is the dedupe key. */
export type BillReminderRow = Readonly<{
  id: string;
  pushSentAt: Date | null;
}>;

export type NewBillReminder = Readonly<{
  localDate: string;
  title: string;
  body: string;
  month: string;
  dueOccurrenceIds: string[];
  overdueOccurrenceIds: string[];
}>;

export type BillRemindersRepository = Readonly<{
  /** Users with reminders on, a device token, and the device's time zone. */
  listRecipientIds: () => Promise<string[]>;
  listUnpaidOccurrences: (
    userId: string,
    throughDate: string,
    db?: ReminderDb,
  ) => Promise<ReminderOccurrence[]>;
  /** Occurrences named in reminders that were actually pushed. */
  listMentionedOccurrenceIds: (
    userId: string,
    db?: ReminderDb,
  ) => Promise<MentionedOccurrences>;
  /**
   * Serialises reminder work for one user and day across workers, then
   * returns that day's row if one exists. Needs a transaction.
   */
  lockDay: (
    userId: string,
    localDate: string,
    tx: DbTransaction,
  ) => Promise<BillReminderRow | null>;
  insertReminder: (
    userId: string,
    reminder: NewBillReminder,
    tx: DbTransaction,
  ) => Promise<BillReminderRow>;
  updateReminder: (
    userId: string,
    id: string,
    reminder: NewBillReminder,
    tx: DbTransaction,
  ) => Promise<void>;
  markPushSent: (
    userId: string,
    id: string,
    sentAt: Date,
    tx: DbTransaction,
  ) => Promise<void>;
}>;

const payloadOf = (reminder: NewBillReminder) => ({
  localDate: reminder.localDate,
  month: reminder.month,
  dueOccurrenceIds: reminder.dueOccurrenceIds,
  overdueOccurrenceIds: reminder.overdueOccurrenceIds,
});

export function createBillRemindersRepository(
  db: Db = getDb(),
): BillRemindersRepository {
  return {
    async listRecipientIds() {
      const rows = await db
        .select({ userId: schema.notificationPreferences.userId })
        .from(schema.notificationPreferences)
        .where(
          and(
            eq(schema.notificationPreferences.billRemindersEnabled, true),
            isNotNull(schema.notificationPreferences.pushToken),
            isNotNull(schema.notificationPreferences.pushTimeZone),
          ),
        );
      return rows.map((row) => row.userId);
    },

    async listUnpaidOccurrences(userId, throughDate, tx = db) {
      const dueDate = sql<string>`COALESCE(${schema.billOccurrences.dueDateOverride}, ${schema.billOccurrences.dueDate})::text`;
      const rows = await tx
        .select({
          occurrenceId: schema.billOccurrences.id,
          dueDate,
          amountCents:
            sql<bigint>`COALESCE(${schema.billOccurrences.expectedAmountOverrideCents}, ${schema.billOccurrences.expectedAmountCents})`.mapWith(
              BigInt,
            ),
          displayName: schema.billSetup.displayName,
          canonicalName: schema.billSetup.canonicalName,
        })
        .from(schema.billOccurrences)
        .innerJoin(
          schema.billSetup,
          and(
            eq(schema.billSetup.id, schema.billOccurrences.billSetupId),
            eq(schema.billSetup.userId, userId),
          ),
        )
        .where(
          and(
            eq(schema.billOccurrences.userId, userId),
            inArray(schema.billOccurrences.status, [
              "upcoming",
              "overdue",
              "processing",
            ]),
            eq(schema.billSetup.status, "active"),
            eq(schema.billSetup.isIncome, false),
            isNull(schema.billSetup.deletedAt),
            sql`${dueDate}::date <= ${throughDate}::date`,
          ),
        )
        .orderBy(dueDate, schema.billSetup.canonicalName);
      return rows.map((row) => ({
        occurrenceId: row.occurrenceId,
        dueDate: row.dueDate,
        amountCents: row.amountCents,
        name: billDisplayName(row.displayName, row.canonicalName),
      }));
    },

    async listMentionedOccurrenceIds(userId, tx = db) {
      const rows = await tx
        .select({ payload: schema.notifications.payload })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.type, BILL_REMINDER_NOTIFICATION_TYPE),
            isNotNull(schema.notifications.pushSentAt),
            // Occurrences are monthly at most; older reminders can't name
            // one that is still unpaid and in range.
            gte(
              schema.notifications.createdAt,
              sql`now() - interval '400 days'`,
            ),
          ),
        )
        .orderBy(desc(schema.notifications.createdAt));
      const due = new Set<string>();
      const overdue = new Set<string>();
      const collect = (list: unknown, into: Set<string>) => {
        if (Array.isArray(list))
          for (const id of list) if (typeof id === "string") into.add(id);
      };
      for (const { payload } of rows) {
        const value = payload as {
          dueOccurrenceIds?: unknown;
          overdueOccurrenceIds?: unknown;
        } | null;
        collect(value?.dueOccurrenceIds, due);
        collect(value?.overdueOccurrenceIds, overdue);
      }
      return { due, overdue };
    },

    async lockDay(userId, localDate, tx) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bill_reminder:${userId}:${localDate}`}, 0))`,
      );
      const rows = await tx
        .select({
          id: schema.notifications.id,
          pushSentAt: schema.notifications.pushSentAt,
        })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.type, BILL_REMINDER_NOTIFICATION_TYPE),
            sql`${schema.notifications.payload}->>'localDate' = ${localDate}`,
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async insertReminder(userId, reminder, tx) {
      const rows = await tx
        .insert(schema.notifications)
        .values({
          userId,
          type: BILL_REMINDER_NOTIFICATION_TYPE,
          title: reminder.title,
          body: reminder.body,
          payload: payloadOf(reminder),
          sentAt: new Date(),
        })
        .returning({
          id: schema.notifications.id,
          pushSentAt: schema.notifications.pushSentAt,
        });
      const row = rows[0];
      if (!row) throw new Error("Bill reminder insert returned no row");
      return row;
    },

    async updateReminder(userId, id, reminder, tx) {
      await tx
        .update(schema.notifications)
        .set({
          title: reminder.title,
          body: reminder.body,
          payload: payloadOf(reminder),
        })
        .where(
          and(
            eq(schema.notifications.id, id),
            eq(schema.notifications.userId, userId),
          ),
        );
    },

    async markPushSent(userId, id, sentAt, tx) {
      await tx
        .update(schema.notifications)
        .set({ pushSentAt: sentAt })
        .where(
          and(
            eq(schema.notifications.id, id),
            eq(schema.notifications.userId, userId),
          ),
        );
    },
  };
}
