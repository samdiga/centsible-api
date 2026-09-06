import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../../../app/create-http-app.js";
import { ServiceUnavailableError } from "../../../platform/errors/app-error.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import type { UserDataService } from "../user-data.service.js";
import { BACKUP_VERSION, type BackupPayload } from "../user-data.schemas.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const emptyBackup: BackupPayload = {
  version: BACKUP_VERSION,
  exportedAt: "2026-09-01T00:00:00.000Z",
  accounts: [],
  transactions: [],
  categories: [],
  rules: [],
  budgets: [],
  recurring: [],
};

function app(service: UserDataService) {
  return createHttpApp({ auth, userDataService: service });
}

describe("user data routes", () => {
  it("requires authentication", async () => {
    const service = {} as UserDataService;
    const response = await createHttpApp({ userDataService: service }).request(
      "/user/export",
    );
    expect(response.status).toBe(401);
  });

  it("streams an uncached JSON export", async () => {
    const exportUserData = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"transactions":[]}'));
            controller.close();
          },
        }),
    );
    const service: UserDataService = {
      exportUserData,
      importUserData: vi.fn(),
      resetUserData: vi.fn(),
    };

    const response = await app(service).request("/user/export", {
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ transactions: [] });
    expect(exportUserData).toHaveBeenCalledWith(USER_ID);
  });

  it("validates imports before invoking the service and returns the exact success body", async () => {
    const service: UserDataService = {
      exportUserData: vi.fn(),
      importUserData: vi.fn(async () => undefined),
      resetUserData: vi.fn(),
    };
    const invalid = await app(service).request("/user/import", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...emptyBackup, version: 99 }),
    });
    expect(invalid.status).toBe(400);
    expect(service.importUserData).not.toHaveBeenCalled();

    const valid = await app(service).request("/user/import", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(emptyBackup),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ ok: true });
    expect(service.importUserData).toHaveBeenCalledWith(USER_ID, emptyBackup);
  });

  it("resets through the service and returns the exact success body", async () => {
    const service: UserDataService = {
      exportUserData: vi.fn(),
      importUserData: vi.fn(),
      resetUserData: vi.fn(async () => undefined),
    };
    const response = await app(service).request("/user/data", {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(service.resetUserData).toHaveBeenCalledWith(USER_ID);
  });

  it("returns typed service-unavailable errors for destructive operations", async () => {
    const service: UserDataService = {
      exportUserData: vi.fn(),
      importUserData: vi.fn(async () => {
        throw new ServiceUnavailableError();
      }),
      resetUserData: vi.fn(async () => {
        throw new ServiceUnavailableError();
      }),
    };

    const imported = await app(service).request("/user/import", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(emptyBackup),
    });
    const reset = await app(service).request("/user/data", {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });

    expect(imported.status).toBe(503);
    expect(reset.status).toBe(503);
    expect(await imported.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(await reset.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });
});
