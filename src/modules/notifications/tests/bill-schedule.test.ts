import { describe, expect, it } from "vitest";

import {
  computeBillNotifications,
  nextReminder,
  type NotificationPrefsInput,
} from "../bill-schedule.js";

const prefs: NotificationPrefsInput = {
  billReminderDaysAhead: 3,
  quietHoursEnabled: true,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  reminderHour: 9,
  timeZone: "America/New_York",
};

describe("computeBillNotifications", () => {
  it("computes daysAhead from the local calendar date", () => {
    expect(
      nextReminder({
        dueDate: "2026-09-05",
        daysAhead: 2,
        timezone: "America/New_York",
      }),
    ).toEqual(new Date("2026-09-03T13:00:00Z"));
  });

  it("skips missing dates and invalid timezones", () => {
    expect(
      nextReminder({ dueDate: null, daysAhead: 2, timezone: "UTC" }),
    ).toBeNull();
    expect(
      nextReminder({
        dueDate: "2026-09-05",
        daysAhead: 2,
        timezone: "Mars/Olympus",
      }),
    ).toBeNull();
  });

  it("emits upcoming, due-today, and overdue notifications for a future bill", () => {
    const out = computeBillNotifications(
      {
        id: "b1",
        name: "Rent",
        nextExpectedDate: "2026-06-10",
        amountCents: 145000n,
      },
      prefs,
      new Date("2026-06-01T12:00:00Z"),
    );

    expect(out.map((o) => o.kind).sort()).toEqual([
      "due_today",
      "overdue",
      "upcoming",
    ]);
    expect(out.find((o) => o.kind === "upcoming")?.fireDate).toEqual(
      new Date("2026-06-07T13:00:00Z"),
    );
  });

  it("skips fire dates already in the past", () => {
    const out = computeBillNotifications(
      {
        id: "b1",
        name: "Rent",
        nextExpectedDate: "2026-06-01",
        amountCents: 1000n,
      },
      prefs,
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(out.find((o) => o.kind === "upcoming")).toBeUndefined();
  });

  it("pushes overnight quiet-hours reminders to quietHoursEnd on the next local date", () => {
    const out = computeBillNotifications(
      {
        id: "b1",
        name: "Rent",
        nextExpectedDate: "2026-06-10",
        amountCents: 1000n,
      },
      { ...prefs, reminderHour: 23 },
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(out.find((o) => o.kind === "upcoming")?.fireDate).toEqual(
      new Date("2026-06-08T11:00:00Z"),
    );
  });

  it("keeps cents in reminder copy", () => {
    const out = computeBillNotifications(
      {
        id: "b1",
        name: "Subscription",
        nextExpectedDate: "2026-06-10",
        amountCents: 145000n,
      },
      prefs,
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(out.find((o) => o.kind === "due_today")?.body).toContain(
      "$1,450.00",
    );
  });

  it("preserves the negative sign while formatting grouped cents", () => {
    const out = computeBillNotifications(
      {
        id: "b1",
        name: "Refund",
        nextExpectedDate: "2026-06-10",
        amountCents: -145000n,
      },
      prefs,
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(out.find((o) => o.kind === "due_today")?.body).toContain(
      "-$1,450.00",
    );
  });

  it("uses ISO calendar arithmetic across month boundaries regardless of process timezone", () => {
    const out = computeBillNotifications(
      {
        id: "b1",
        name: "Rent",
        nextExpectedDate: "2026-03-01",
        amountCents: 1000n,
      },
      { ...prefs, billReminderDaysAhead: 2 },
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(out.find((o) => o.kind === "upcoming")?.fireDate).toEqual(
      new Date("2026-02-27T14:00:00Z"),
    );
  });

  it("keeps New York local reminder hour through spring and fall DST", () => {
    const spring = computeBillNotifications(
      {
        id: "spring",
        name: "Spring",
        nextExpectedDate: "2026-03-10",
        amountCents: 1000n,
      },
      prefs,
      new Date("2026-03-01T00:00:00Z"),
    );
    const fall = computeBillNotifications(
      {
        id: "fall",
        name: "Fall",
        nextExpectedDate: "2026-11-10",
        amountCents: 1000n,
      },
      prefs,
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(spring.find((o) => o.kind === "due_today")?.fireDate).toEqual(
      new Date("2026-03-10T13:00:00Z"),
    );
    expect(fall.find((o) => o.kind === "due_today")?.fireDate).toEqual(
      new Date("2026-11-10T14:00:00Z"),
    );
  });

  it("derives quiet-hour wall date in an east-of-UTC timezone", () => {
    const out = computeBillNotifications(
      {
        id: "tokyo",
        name: "Tokyo",
        nextExpectedDate: "2026-06-10",
        amountCents: 1000n,
      },
      {
        ...prefs,
        reminderHour: 23,
        timeZone: "Asia/Tokyo",
      },
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(out.find((o) => o.kind === "upcoming")?.fireDate).toEqual(
      new Date("2026-06-07T22:00:00Z"),
    );
  });

  it("rolls overnight quiet hours across New York DST boundaries", () => {
    const spring = computeBillNotifications(
      {
        id: "spring-overnight",
        name: "Spring",
        nextExpectedDate: "2026-03-09",
        amountCents: 1000n,
      },
      { ...prefs, reminderHour: 23 },
      new Date("2026-03-01T00:00:00Z"),
    );
    const fall = computeBillNotifications(
      {
        id: "fall-overnight",
        name: "Fall",
        nextExpectedDate: "2026-11-02",
        amountCents: 1000n,
      },
      { ...prefs, reminderHour: 23 },
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(spring.find((o) => o.kind === "due_today")?.fireDate).toEqual(
      new Date("2026-03-10T11:00:00Z"),
    );
    expect(fall.find((o) => o.kind === "due_today")?.fireDate).toEqual(
      new Date("2026-11-03T12:00:00Z"),
    );
  });
});
