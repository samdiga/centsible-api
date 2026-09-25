import { describe, expect, it, vi } from "vitest";

import { createSyncHealthAlertsService } from "../sync-health-alerts.service.js";
import type {
  NewSyncHealthAlert,
  OpenSyncHealthAlert,
  SyncHealthAlertsRepository,
  SyncHealthItem,
} from "../sync-health-alerts.repository.js";

const USER = "11111111-1111-4111-8111-111111111111";
// 2026-09-25 18:00 UTC = 11:00 in Los Angeles: outside 22-7 quiet hours.
const MIDDAY = new Date("2026-09-25T18:00:00.000Z");
// 2026-09-26 07:00 UTC = 00:00 in Los Angeles: inside quiet hours.
const NIGHT = new Date("2026-09-26T07:00:00.000Z");

const item = (overrides: Partial<SyncHealthItem> = {}): SyncHealthItem => ({
  id: "item-1",
  institutionName: "Chase",
  status: "active",
  cursor: "cursor",
  lastSyncAt: new Date("2026-09-25T12:00:00.000Z"),
  ...overrides,
});

function harness(
  options: {
    items?: SyncHealthItem[];
    open?: OpenSyncHealthAlert[];
    prefs?: Partial<{
      syncAlertsEnabled: boolean;
      pushToken: string | null;
      quietHoursEnabled: boolean;
    }>;
    now?: Date;
    sendOutcome?: "sent" | "invalid-token" | "retryable";
  } = {},
) {
  const open = [...(options.open ?? [])];
  const repository: SyncHealthAlertsRepository = {
    listUserIdsWithItems: vi.fn(async () => [USER]),
    listItems: vi.fn(async () => options.items ?? [item()]),
    listOpenAlerts: vi.fn(async () => open),
    insertAlert: vi.fn(async (_u: string, alert: NewSyncHealthAlert) => {
      const row = {
        id: `n-${alert.plaidItemId}`,
        plaidItemId: alert.plaidItemId,
        title: alert.title,
        body: alert.body,
        pushSentAt: null,
      };
      open.push(row);
      return row;
    }),
    resolveAlerts: vi.fn(async () => 1),
    markPushSent: vi.fn(async () => undefined),
    userTimeZone: vi.fn(async () => "America/Los_Angeles"),
  };
  const clearPushToken = vi.fn(async () => ({}) as never);
  const send = vi.fn(
    async (input: { onInvalidToken?: () => Promise<void> | void }) => {
      const outcome = options.sendOutcome ?? "sent";
      if (outcome === "invalid-token") {
        await input.onInvalidToken?.();
        return { outcome, status: 410, reason: "Unregistered" } as const;
      }
      return outcome === "sent"
        ? ({ outcome } as const)
        : ({ outcome, status: 503 } as const);
    },
  );
  const deferRun = vi.fn(async () => undefined);
  const service = createSyncHealthAlertsService({
    repository,
    preferences: {
      getOrCreatePreferences: vi.fn(async () => ({
        syncAlertsEnabled: true,
        pushToken: "device-token",
        quietHoursEnabled: true,
        quietHoursStart: 22,
        quietHoursEnd: 7,
        ...options.prefs,
      })) as never,
      clearPushToken,
    },
    sender: { isEnabled: () => true, send },
    deferRun,
    now: () => options.now ?? MIDDAY,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  return { service, repository, send, deferRun, clearPushToken };
}

describe("sync-health alerts", () => {
  it("writes one alert and pushes it when a connection needs relinking", async () => {
    const h = harness({ items: [item({ status: "login_required" })] });
    await expect(h.service.runForUser(USER)).resolves.toEqual({
      created: 1,
      resolved: 0,
      pushed: 1,
      deferredUntil: null,
    });
    expect(h.repository.insertAlert).toHaveBeenCalledWith(USER, {
      plaidItemId: "item-1",
      health: "needs_relink",
      title: "Connection needs attention",
      body: "Chase needs you to sign in again so your accounts keep updating.",
    });
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceToken: "device-token",
        payload: expect.objectContaining({
          type: "sync_health",
          plaidItemId: "item-1",
        }),
      }),
    );
    expect(h.repository.markPushSent).toHaveBeenCalledWith(
      USER,
      "n-item-1",
      MIDDAY,
    );
  });

  it("does not alert again during the same unhealthy episode", async () => {
    const h = harness({
      items: [item({ status: "error" })],
      open: [
        {
          id: "n1",
          plaidItemId: "item-1",
          title: "t",
          body: "b",
          pushSentAt: MIDDAY,
        },
      ],
    });
    const result = await h.service.runForUser(USER);
    expect(result).toMatchObject({ created: 0, pushed: 0 });
    expect(h.repository.insertAlert).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("closes the episode once the connection is healthy, without pushing", async () => {
    const h = harness({
      items: [item()],
      open: [
        {
          id: "n1",
          plaidItemId: "item-1",
          title: "t",
          body: "b",
          pushSentAt: null,
        },
      ],
    });
    const result = await h.service.runForUser(USER);
    expect(result).toMatchObject({ created: 0, resolved: 1, pushed: 0 });
    expect(h.repository.resolveAlerts).toHaveBeenCalledWith(
      USER,
      "item-1",
      MIDDAY,
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it("treats a connection without a successful sync for over 72 hours as stale", async () => {
    const h = harness({
      items: [item({ lastSyncAt: new Date("2026-09-22T17:59:00.000Z") })],
    });
    await h.service.runForUser(USER);
    expect(h.repository.insertAlert).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ health: "stale" }),
    );
  });

  it("does nothing when connection alerts are turned off", async () => {
    const h = harness({
      items: [item({ status: "login_required" })],
      prefs: { syncAlertsEnabled: false },
    });
    await expect(h.service.runForUser(USER)).resolves.toMatchObject({
      created: 0,
    });
    expect(h.repository.listItems).not.toHaveBeenCalled();
  });

  it("defers the push to the end of quiet hours instead of dropping it", async () => {
    const h = harness({
      items: [item({ status: "login_required" })],
      now: NIGHT,
    });
    const result = await h.service.runForUser(USER);
    // 07:00 in Los Angeles on 2026-09-26 is 14:00 UTC.
    const quietEnd = new Date("2026-09-26T14:00:00.000Z");
    expect(result).toEqual({
      created: 1,
      resolved: 0,
      pushed: 0,
      deferredUntil: quietEnd,
    });
    expect(h.deferRun).toHaveBeenCalledWith(USER, quietEnd);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("keeps the alert without pushing when no device token is registered", async () => {
    const h = harness({
      items: [item({ status: "login_required" })],
      prefs: { pushToken: null },
    });
    await expect(h.service.runForUser(USER)).resolves.toMatchObject({
      created: 1,
      pushed: 0,
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("clears an unregistered device token and stops sending", async () => {
    const h = harness({
      items: [
        item({ id: "a", status: "login_required" }),
        item({ id: "b", status: "error" }),
      ],
      sendOutcome: "invalid-token",
    });
    await expect(h.service.runForUser(USER)).resolves.toMatchObject({
      created: 2,
      pushed: 0,
    });
    expect(h.clearPushToken).toHaveBeenCalledWith(USER);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("leaves a retryable push pending for the next run", async () => {
    const h = harness({
      items: [item({ status: "login_required" })],
      sendOutcome: "retryable",
    });
    await expect(h.service.runForUser(USER)).resolves.toMatchObject({
      created: 1,
      pushed: 0,
    });
    expect(h.repository.markPushSent).not.toHaveBeenCalled();
  });

  it("never pushes an open alert for a connection that no longer exists", async () => {
    const h = harness({
      items: [],
      open: [
        {
          id: "n1",
          plaidItemId: "gone",
          title: "t",
          body: "b",
          pushSentAt: null,
        },
      ],
    });
    await expect(h.service.runForUser(USER)).resolves.toMatchObject({
      pushed: 0,
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("isolates one user's failure during the sweep", async () => {
    const h = harness();
    vi.mocked(h.repository.listUserIdsWithItems).mockResolvedValueOnce([
      "bad",
      USER,
    ]);
    vi.mocked(h.repository.listItems).mockRejectedValueOnce(new Error("boom"));
    await expect(h.service.runForAllUsers()).resolves.toEqual({
      users: 2,
      failed: 1,
    });
  });
});
