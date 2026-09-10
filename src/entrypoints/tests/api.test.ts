import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../app/create-http-app.js";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import type { Env } from "../../platform/config/env.js";
import { startApi } from "../api.js";

describe("startApi", () => {
  it("owns the configured listener and closes it before the database exactly once", async () => {
    const order: string[] = [];
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        order.push("server");
        callback();
      }),
    } as unknown as ServerType;
    const gracefulShutdown = vi.fn((close: () => Promise<void>) => close);
    const closeDb = vi.fn(async () => {
      order.push("db");
    });
    const notificationAdapter = {
      listen: vi.fn(async () => {
        order.push("listen");
        return {
          unlisten: async () => {
            order.push("unlisten");
          },
        };
      }),
      close: vi.fn(async () => {
        order.push("notification");
      }),
    };
    const info = vi.fn();
    const startServer = vi.fn(() => {
      order.push("serve");
      return server;
    }) as unknown as typeof serve;
    const start = await startApi({
      loadEnv: vi.fn(() => ({ API_HOST: "100.64.0.42", PORT: 4312 }) as Env),
      createHttpApp: vi.fn(createHttpApp),
      serve: startServer,
      closeDb,
      responseCache: createResponseCache(),
      createNotificationAdapter: () => notificationAdapter,
      installGracefulShutdown: gracefulShutdown,
      startupLogger: { info, error: vi.fn() },
    });

    expect(start.server).toBe(server);
    expect(startServer).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      hostname: "100.64.0.42",
      port: 4312,
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "centsible-api",
        role: "api",
        revision: expect.any(String),
      }),
      "API listening",
    );

    await start.close();
    await start.close();

    expect(order).toEqual([
      "listen",
      "serve",
      "server",
      "unlisten",
      "notification",
      "db",
    ]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(notificationAdapter.listen).toHaveBeenCalledTimes(1);
    expect(notificationAdapter.close).toHaveBeenCalledTimes(1);
    expect(gracefulShutdown).toHaveBeenCalledWith(start.close);
  });

  it("tolerates an already-closed server before closing the database", async () => {
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        callback(
          Object.assign(new Error("closed"), {
            code: "ERR_SERVER_NOT_RUNNING",
          }),
        );
      }),
    } as unknown as ServerType;
    const closeDb = vi.fn(async () => undefined);

    const runtime = await startApi({
      loadEnv: () => ({ API_HOST: "127.0.0.1", PORT: 4312 }) as Env,
      serve: (() => server) as typeof serve,
      closeDb,
      responseCache: createResponseCache(),
      createNotificationAdapter: () => ({
        listen: async () => ({ unlisten: async () => undefined }),
        close: async () => undefined,
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(closeDb).toHaveBeenCalledTimes(1);
  });

  it("passes the validated environment into HTTP composition", async () => {
    const configuration = {
      API_HOST: "127.0.0.1",
      PORT: 4312,
      API_DOCS_ENABLED: false,
    } as Env;
    const createApp = vi.fn(createHttpApp);
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    } as unknown as ServerType;

    await startApi({
      loadEnv: () => configuration,
      createHttpApp: createApp,
      serve: (() => server) as typeof serve,
      closeDb: async () => undefined,
      responseCache: createResponseCache(),
      createNotificationAdapter: () => ({
        listen: async () => ({ unlisten: async () => undefined }),
        close: async () => undefined,
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    expect(createApp).toHaveBeenCalledWith(
      expect.objectContaining({ env: configuration }),
    );
  });

  it("fails before serving and closes the notification connection when listener startup fails", async () => {
    const serve = vi.fn(() => {
      throw new Error("serve must not run");
    }) as unknown as typeof import("@hono/node-server").serve;
    const close = vi.fn(async () => undefined);
    const listenerError = new Error("LISTEN unavailable");

    await expect(
      startApi({
        loadEnv: () =>
          ({
            API_HOST: "127.0.0.1",
            PORT: 4312,
            DATABASE_URL: "postgres://example",
          }) as Env,
        serve,
        closeDb: close,
        createNotificationAdapter: () => ({
          listen: async () => Promise.reject(listenerError),
          close,
        }),
        installGracefulShutdown: () => () => undefined,
        startupLogger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toBe(listenerError);

    expect(serve).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("attempts every shutdown step when listener cleanup fails", async () => {
    const order: string[] = [];
    const listenerError = new Error("UNLISTEN unavailable");
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        order.push("server");
        callback();
      }),
    } as unknown as ServerType;
    const runtime = await startApi({
      loadEnv: () =>
        ({
          API_HOST: "127.0.0.1",
          PORT: 4312,
          DATABASE_URL: "postgres://example",
        }) as Env,
      serve: (() => server) as typeof serve,
      closeDb: async () => void order.push("db"),
      createNotificationAdapter: () => ({
        listen: async () => ({
          unlisten: async () => {
            order.push("unlisten");
            throw listenerError;
          },
        }),
        close: async () => void order.push("notification"),
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    await expect(runtime.close()).rejects.toBe(listenerError);
    expect(order).toEqual(["server", "unlisten", "notification", "db"]);
  });
});
