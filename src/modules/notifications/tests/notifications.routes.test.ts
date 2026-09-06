import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../../../app/create-http-app.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import { createResponseCache } from "../../../platform/cache/response-cache.js";
import { createNotificationsService } from "../notifications.service.js";
import type { NotificationPreferencesService } from "../notifications.service.js";
import type { NotificationPreferencesRow } from "../notifications.repository.js";
import {
  createNotificationPreferencesRepository,
  notificationPreferencesRepository,
} from "../notifications.repository.js";
import type { Db } from "../../../platform/database/types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const row = {
  userId: USER_ID,
  billRemindersEnabled: true,
  billReminderDaysAhead: 3,
  quietHoursEnabled: true,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  updatedAt: new Date("2026-09-01T00:00:00Z"),
} as unknown as NotificationPreferencesRow;

function request(
  service: NotificationPreferencesService,
  method: string,
  body?: unknown,
) {
  return createHttpApp({ auth, notificationsService: service }).request(
    "/notifications/preferences",
    {
      method,
      headers: {
        authorization: "Bearer test-token",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe("notification preference routes", () => {
  it("requires authentication", async () => {
    const response = await createHttpApp().request(
      "/notifications/preferences",
    );
    expect(response.status).toBe(401);
  });

  it("returns get-or-create defaults with the exact response shape", async () => {
    const service: NotificationPreferencesService = {
      getPreferences: vi.fn(async () => row),
      updatePreferences: vi.fn(),
    };
    const response = await request(service, "GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      preferences: {
        billRemindersEnabled: true,
        billReminderDaysAhead: 3,
        quietHoursEnabled: true,
        quietHoursStart: 22,
        quietHoursEnd: 7,
      },
    });
  });

  it("rejects empty and invalid preference patches", async () => {
    const service: NotificationPreferencesService = {
      getPreferences: vi.fn(),
      updatePreferences: vi.fn(),
    };
    for (const body of [{}, { billReminderDaysAhead: 31 }]) {
      const response = await request(service, "PATCH", body);
      expect(response.status).toBe(400);
      expect(service.updatePreferences).not.toHaveBeenCalled();
    }
  });

  it("validates service output at the HTTP boundary", async () => {
    const service: NotificationPreferencesService = {
      getPreferences: vi.fn(async () => ({
        ...row,
        billReminderDaysAhead: 99,
      })),
      updatePreferences: vi.fn(),
    };
    const response = await request(service, "GET");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "INTERNAL" },
    });
  });

  it("runs PATCH through withUserMutation and invalidates the shared cache", async () => {
    const cache = createResponseCache();
    let mutationCalls = 0;
    let revision = 0n;
    const service = createNotificationsService({
      repository: {
        getOrCreatePreferences: vi.fn(async () => row),
        updatePreferences: vi.fn(async (_userId, input) => ({
          ...row,
          ...input,
        })),
        recordAudit: vi.fn(async () => undefined),
      },
      cache,
      getUserRevision: async () => revision,
      withUserMutation: async (_userId, mutate) => {
        mutationCalls += 1;
        const result = await mutate({} as never);
        revision += 1n;
        cache.invalidateUser(USER_ID);
        return result;
      },
    });
    await request(service, "GET");
    await request(service, "PATCH", { quietHoursEnabled: false });
    expect(mutationCalls).toBe(1);
    expect(revision).toBe(1n);
    expect(cache.stats().userInvalidations).toBe(1);
  });

  it("uses a revision-keyed five-minute response cache for GET", async () => {
    const cache = createResponseCache();
    let reads = 0;
    const service = createNotificationsService({
      repository: {
        getOrCreatePreferences: vi.fn(async () => {
          reads += 1;
          return row;
        }),
        updatePreferences: vi.fn(),
        recordAudit: vi.fn(async () => undefined),
      },
      cache,
      getUserRevision: async () => 5n,
    });
    await service.getPreferences(USER_ID);
    await service.getPreferences(USER_ID);
    expect(reads).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, ttlMs: 300_000 });
  });

  it("refuses to mutate when the repository has no audit capability", async () => {
    const service = createNotificationsService({
      repository: {
        getOrCreatePreferences: vi.fn(async () => row),
        updatePreferences: vi.fn(async (_userId, input) => ({
          ...row,
          ...input,
        })),
      } as never,
      withUserMutation: async (_userId, mutate) => mutate({} as never),
    });
    await expect(
      service.updatePreferences(USER_ID, { quietHoursEnabled: false }),
    ).rejects.toThrow("audit");
  });

  it("forwards a supplied transaction through the repository factory get path", async () => {
    const transaction = {} as Db;
    const getOrCreate = vi
      .spyOn(notificationPreferencesRepository, "getOrCreatePreferences")
      .mockResolvedValue(row);
    try {
      await createNotificationPreferencesRepository(
        {} as Db,
      ).getOrCreatePreferences(USER_ID, transaction);
      expect(getOrCreate).toHaveBeenCalledWith(USER_ID, transaction);
    } finally {
      getOrCreate.mockRestore();
    }
  });
});
