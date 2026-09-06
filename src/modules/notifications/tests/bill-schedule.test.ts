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

  it("rejects out-of-range or fractional daysAhead and reminder hours", () => {
    for (const daysAhead of [-1, 31, 1.5]) {
      expect(
        nextReminder({
          dueDate: "2026-09-05",
          daysAhead,
          timezone: "UTC",
        }),
      ).toBeNull();
    }
    for (const reminderHour of [-1, 24, 1.5]) {
      expect(
        nextReminder({
          dueDate: "2026-09-05",
          daysAhead: 0,
          timezone: "UTC",
          reminderHour,
        }),
      ).toBeNull();
    }
    expect(
      nextReminder({ dueDate: "2026-09-05", daysAhead: 0, timezone: "UTC" }),
    ).toEqual(new Date("2026-09-05T09:00:00Z"));
    expect(
      nextReminder({ dueDate: "2026-09-05", daysAhead: 30, timezone: "UTC" }),
    ).toEqual(new Date("2026-08-06T09:00:00Z"));
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

  it("resolves fractional positive offsets with the exact local minute", () => {
    const kathmandu = nextReminder({
      dueDate: "2026-09-05",
      daysAhead: 0,
      timezone: "Asia/Kathmandu",
    });
    const adelaide = nextReminder({
      dueDate: "2026-07-01",
      daysAhead: 0,
      timezone: "Australia/Adelaide",
    });
    expect(kathmandu).toEqual(new Date("2026-09-05T03:15:00Z"));
    // Adelaide is UTC+09:30 after its DST transition has ended.
    expect(adelaide).toEqual(new Date("2026-06-30T23:30:00Z"));
  });

  it("rolls fractional-offset overnight quiet hours to the next local date", () => {
    const out = computeBillNotifications(
      {
        id: "kathmandu-overnight",
        name: "Kathmandu",
        nextExpectedDate: "2026-09-05",
        amountCents: 1000n,
      },
      {
        ...prefs,
        reminderHour: 23,
        timeZone: "Asia/Kathmandu",
      },
      new Date("2026-09-01T00:00:00Z"),
    );
    expect(out.find((o) => o.kind === "due_today")?.fireDate).toEqual(
      new Date("2026-09-06T01:15:00Z"),
    );
  });

  it("returns null for a nonexistent local DST-gap time", () => {
    // Adelaide skips 02:00 at the spring-forward transition; no instant is
    // silently substituted for that nonexistent local reminder time.
    expect(
      nextReminder({
        dueDate: "2026-10-04",
        daysAhead: 0,
        timezone: "Australia/Adelaide",
        reminderHour: 2,
      }),
    ).toBeNull();
  });

  it("resolves an ambiguous New York DST fold deterministically", () => {
    // The first 01:00 occurrence (EDT) is selected for the fall-back fold.
    expect(
      nextReminder({
        dueDate: "2026-11-01",
        daysAhead: 0,
        timezone: "America/New_York",
        reminderHour: 1,
      }),
    ).toEqual(new Date("2026-11-01T05:00:00Z"));
  });

  it("rejects invalid quiet-hour fields in the compute path", () => {
    for (const field of ["quietHoursStart", "quietHoursEnd"] as const) {
      for (const value of [-1, 24, 1.5]) {
        expect(
          computeBillNotifications(
            {
              id: "invalid-quiet",
              name: "Invalid",
              nextExpectedDate: "2026-09-05",
              amountCents: 1000n,
            },
            { ...prefs, [field]: value },
            new Date("2026-09-01T00:00:00Z"),
          ),
        ).toEqual([]);
      }
    }
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
