import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  billOccurrences,
  billSetup,
  notificationPreferences,
  notifications,
  users,
} from "../../../database/schema/index.js";
import { createBillRemindersRepository } from "../../../src/modules/notifications/bill-reminders.repository.js";
import { createBillRemindersService } from "../../../src/modules/notifications/bill-reminders.service.js";
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

guardedDescribe("bill reminder pushes", () => {
  it("sends one push per user per local day, with only that user's unpaid bills", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherId = randomUUID();
      await testDb.db
        .insert(users)
        .values(
          [userId, otherId].map((id) => ({ id, email: `${id}@example.test` })),
        );
      const preferences = createNotificationPreferencesRepository(testDb.db);
      // An older app build registers without its zone: nothing is sent.
      await preferences.setPushToken(userId, {
        pushToken: "device-token",
        pushPlatform: "ios",
        pushEnvironment: "production",
      });
      const repository = createBillRemindersRepository(testDb.db);
      expect(await repository.listRecipientIds()).toEqual([]);
      await preferences.setPushToken(userId, {
        pushToken: "device-token",
        pushPlatform: "ios",
        pushEnvironment: "production",
        pushTimeZone: "America/New_York",
        pushHideAmounts: false,
      });
      // Omitted fields keep what the device reported earlier.
      const kept = await preferences.setPushToken(userId, {
        pushToken: "device-token",
        pushPlatform: "ios",
        pushEnvironment: "production",
      });
      expect(kept).toMatchObject({
        pushTimeZone: "America/New_York",
        pushHideAmounts: false,
      });
      expect(await repository.listRecipientIds()).toEqual([userId]);

      const setups = await testDb.db
        .insert(billSetup)
        .values(
          [
            { userId, canonicalName: "rent", avgAmount: 185000n },
            { userId, canonicalName: "geico", avgAmount: 42000n },
            {
              userId,
              canonicalName: "payroll",
              avgAmount: -250000n,
              isIncome: true,
            },
            {
              userId,
              canonicalName: "old gym",
              avgAmount: 5000n,
              deletedAt: new Date(),
            },
            { userId: otherId, canonicalName: "rent", avgAmount: 99900n },
          ].map((row) => ({
            ...row,
            cadence: "monthly" as const,
            status: "active" as const,
            userConfirmed: true,
          })),
        )
        .returning();
      const occurrence = (
        index: number,
        dueDate: string,
        status: "upcoming" | "overdue" | "paid" = "upcoming",
      ) => ({
        userId: setups[index]!.userId,
        billSetupId: setups[index]!.id,
        occurrenceKey: `${setups[index]!.id}:${dueDate}`,
        dueDate,
        expectedAmountCents: setups[index]!.avgAmount,
        status,
      });
      const inserted = await testDb.db
        .insert(billOccurrences)
        .values([
          occurrence(0, "2026-10-04"),
          occurrence(0, "2026-09-04", "paid"),
          occurrence(1, "2026-09-25", "overdue"),
          occurrence(2, "2026-10-02"),
          occurrence(3, "2026-10-02"),
          occurrence(4, "2026-10-02"),
          occurrence(1, "2026-11-25"),
        ])
        .returning();

      expect(
        (await repository.listUnpaidOccurrences(userId, "2026-10-04")).map(
          ({ occurrenceId, name, dueDate, amountCents }) => ({
            occurrenceId,
            name,
            dueDate,
            amountCents,
          }),
        ),
      ).toEqual([
        {
          occurrenceId: inserted[2]!.id,
          name: "Geico",
          dueDate: "2026-09-25",
          amountCents: 42000n,
        },
        {
          occurrenceId: inserted[0]!.id,
          name: "Rent",
          dueDate: "2026-10-04",
          amountCents: 185000n,
        },
      ]);

      const send = vi.fn(async () => ({ outcome: "sent" as const }));
      const service = (at: string) =>
        createBillRemindersService({
          repository,
          preferences,
          sender: { isEnabled: () => true, send },
          enqueue: async () => undefined,
          transaction: (callback) => testDb.db.transaction(callback),
          now: () => new Date(at),
        });
      // Two workers replaying the same day at once: one push, one row.
      const results = await Promise.all([
        service("2026-10-01T13:05:00Z").runForUser(userId, "2026-10-01"),
        service("2026-10-01T13:05:00Z").runForUser(userId, "2026-10-01"),
      ]);
      expect(results.sort()).toEqual(["already_sent", "sent"]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            aps: expect.objectContaining({
              alert: {
                title: "Rent is due in 3 days",
                body: "Rent $1,850 is due Sun, Oct 4.\n1 overdue: Geico.",
              },
            }),
            type: "bill_reminder",
            month: "2026-10-01",
          }),
        }),
      );
      const rows = await testDb.db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "bill_reminder",
        payload: expect.objectContaining({ localDate: "2026-10-01" }),
      });
      expect(rows[0]!.pushSentAt).not.toBeNull();

      // Next morning: Rent and Geico were already named; nothing new to say.
      expect(
        await service("2026-10-02T13:05:00Z").runForUser(userId, "2026-10-02"),
      ).toBe("nothing_due");
      expect(send).toHaveBeenCalledTimes(1);
      expect(await repository.listMentionedOccurrenceIds(userId)).toEqual({
        due: new Set([inserted[0]!.id]),
        overdue: new Set([inserted[2]!.id]),
      });

      // Turning reminders off stops the pushes.
      await testDb.db
        .update(notificationPreferences)
        .set({ billRemindersEnabled: false })
        .where(eq(notificationPreferences.userId, userId));
      expect(await repository.listRecipientIds()).toEqual([]);
    } finally {
      await testDb.cleanup();
    }
  }, 60_000);
});
