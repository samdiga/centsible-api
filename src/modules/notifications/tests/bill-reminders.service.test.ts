import { describe, expect, it, vi } from "vitest";
import type { BillRemindersRepository } from "../bill-reminders.repository.js";
import { createBillRemindersService } from "../bill-reminders.service.js";
import type { NotificationPreferencesRow } from "../notifications.repository.js";

const USER = "user-1";

const prefsRow = (
  overrides: Partial<NotificationPreferencesRow> = {},
): NotificationPreferencesRow =>
  ({
    userId: USER,
    billRemindersEnabled: true,
    billReminderDaysAhead: 3,
    quietHoursEnabled: false,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    pushToken: "token",
    pushTimeZone: "America/New_York",
    pushHideAmounts: false,
    ...overrides,
  }) as NotificationPreferencesRow;

function setup(
  options: {
    prefs?: Partial<NotificationPreferencesRow>;
    now?: string;
    outcome?: "sent" | "retryable" | "invalid-token";
    senderEnabled?: boolean;
  } = {},
) {
  let sent: string | null = null;
  const repository = {
    listRecipientIds: vi.fn(async () => [USER]),
    listUnpaidOccurrences: vi.fn(async () => [
      {
        occurrenceId: "rent",
        name: "Rent",
        dueDate: "2026-10-04",
        amountCents: 185000n,
      },
    ]),
    listMentionedOccurrenceIds: vi.fn(async () => ({
      due: new Set<string>(),
      overdue: new Set<string>(),
    })),
    lockDay: vi.fn(async () =>
      sent ? { id: "row", pushSentAt: new Date(sent) } : null,
    ),
    insertReminder: vi.fn(async () => ({ id: "row", pushSentAt: null })),
    updateReminder: vi.fn(async () => undefined),
    markPushSent: vi.fn(async (_user: string, _id: string, at: Date) => {
      sent = at.toISOString();
    }),
  } satisfies BillRemindersRepository;
  const preferences = {
    getOrCreatePreferences: vi.fn(async () => prefsRow(options.prefs)),
    clearPushToken: vi.fn(async () => prefsRow({ pushToken: null })),
  };
  const sender = {
    isEnabled: () => options.senderEnabled ?? true,
    send: vi.fn(
      async (input: { onInvalidToken?: () => Promise<void> | void }) => {
        const outcome = options.outcome ?? "sent";
        if (outcome === "invalid-token") {
          await input.onInvalidToken?.();
          return { outcome, status: 410, reason: "Unregistered" } as const;
        }
        return outcome === "sent"
          ? ({ outcome } as const)
          : ({ outcome, status: 503 } as const);
      },
    ),
  };
  const enqueue = vi.fn(async () => undefined);
  const service = createBillRemindersService({
    repository,
    preferences,
    sender,
    enqueue,
    transaction: (callback) => callback({} as never),
    now: () => new Date(options.now ?? "2026-10-01T13:05:00Z"),
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  return { service, repository, preferences, sender, enqueue };
}

describe("bill reminders service", () => {
  it("sends at 9 AM in the device's zone, not the server's", async () => {
    // 9 AM in New York on Oct 1 is 13:00 UTC.
    const early = setup({ now: "2026-10-01T12:30:00Z" });
    expect(await early.service.runForUser(USER, "2026-10-01")).toBe("deferred");
    expect(early.enqueue).toHaveBeenCalledWith(
      USER,
      "2026-10-01",
      new Date("2026-10-01T13:00:00Z"),
    );
    expect(early.sender.send).not.toHaveBeenCalled();

    const onTime = setup({ now: "2026-10-01T13:05:00Z" });
    expect(await onTime.service.runForUser(USER, "2026-10-01")).toBe("sent");
    expect(onTime.sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceToken: "token",
        collapseId: "bill-reminder-2026-10-01",
        payload: {
          aps: {
            alert: {
              title: "Rent is due in 3 days",
              body: "Rent $1,850 is due Sun, Oct 4.",
            },
            sound: "default",
            "thread-id": "bill-reminders",
          },
          type: "bill_reminder",
          month: "2026-10-01",
        },
      }),
    );
    expect(onTime.repository.listUnpaidOccurrences).toHaveBeenCalledWith(
      USER,
      "2026-10-04",
      expect.anything(),
    );
  });

  it("waits for the end of quiet hours", async () => {
    const { service, enqueue, sender } = setup({
      prefs: { quietHoursEnabled: true, quietHoursStart: 8, quietHoursEnd: 10 },
    });
    expect(await service.runForUser(USER, "2026-10-01")).toBe("deferred");
    // 10 AM New York.
    expect(enqueue).toHaveBeenCalledWith(
      USER,
      "2026-10-01",
      new Date("2026-10-01T14:00:00Z"),
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("drops a reminder that runs hours late", async () => {
    const { service, sender } = setup({ now: "2026-10-01T19:30:00Z" });
    expect(await service.runForUser(USER, "2026-10-01")).toBe("stale");
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("sends at most once a day when the job is replayed", async () => {
    const { service, sender, repository } = setup();
    expect(await service.runForUser(USER, "2026-10-01")).toBe("sent");
    expect(await service.runForUser(USER, "2026-10-01")).toBe("already_sent");
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(repository.insertReminder).toHaveBeenCalledTimes(1);
  });

  it("keeps amounts out when the device's blur setting is unknown", async () => {
    const { service, sender } = setup({ prefs: { pushHideAmounts: null } });
    await service.runForUser(USER, "2026-10-01");
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          aps: expect.objectContaining({
            alert: {
              title: "Rent is due in 3 days",
              body: "Rent is due Sun, Oct 4.",
            },
          }),
        }),
      }),
    );
  });

  it("does nothing without reminders on, a device, its zone, or APNs", async () => {
    for (const options of [
      { prefs: { billRemindersEnabled: false } },
      { prefs: { pushToken: null } },
      { prefs: { pushTimeZone: null } },
      { senderEnabled: false },
    ]) {
      const { service, sender, enqueue } = setup(options);
      expect(await service.runForUser(USER, "2026-10-01")).toBe("inactive");
      expect(sender.send).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it("leaves an undelivered reminder unsent so a retry can deliver it", async () => {
    const { service, repository } = setup({ outcome: "retryable" });
    expect(await service.runForUser(USER, "2026-10-01")).toBe("not_delivered");
    expect(repository.insertReminder).toHaveBeenCalledTimes(1);
    expect(repository.markPushSent).not.toHaveBeenCalled();
  });

  it("clears a token APNs rejects", async () => {
    const { service, preferences } = setup({ outcome: "invalid-token" });
    await service.runForUser(USER, "2026-10-01");
    expect(preferences.clearPushToken).toHaveBeenCalledWith(USER);
  });

  it("queues each local day whose send time hasn't long passed", async () => {
    // 03:00 UTC Oct 1 is 11 PM Sep 30 in New York: today's 9 AM has long
    // gone, tomorrow's is queued.
    const newYork = setup({ now: "2026-10-01T03:00:00Z" });
    expect(await newYork.service.scheduleAll()).toEqual({
      users: 1,
      queued: 1,
      failed: 0,
    });
    expect(newYork.enqueue).toHaveBeenCalledWith(
      USER,
      "2026-10-01",
      new Date("2026-10-01T13:00:00Z"),
    );

    // 13:00 in Tokyo: today's 9 AM was 4 hours ago, so it goes now; tomorrow's
    // is queued too.
    const tokyo = setup({
      now: "2026-10-01T04:00:00Z",
      prefs: { pushTimeZone: "Asia/Tokyo" },
    });
    await tokyo.service.scheduleAll();
    expect(tokyo.enqueue.mock.calls).toEqual([
      [USER, "2026-10-01", new Date("2026-10-01T04:00:00Z")],
      [USER, "2026-10-02", new Date("2026-10-02T00:00:00Z")],
    ]);
  });
});
