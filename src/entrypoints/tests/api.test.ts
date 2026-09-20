import { EventEmitter } from "node:events";
import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { createHttpApp } from "../../app/create-http-app.js";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import type { Env } from "../../platform/config/env.js";
import { startApi } from "../api.js";

function serveImmediately(
  server: ServerType,
  onServe?: (() => void) | undefined,
): typeof serve {
  return ((_options, listening) => {
    onServe?.();
    listening?.(null as never);
    return server;
  }) as typeof serve;
}

describe("startApi", () => {
  it.each([false, undefined])(
    "uses a pass-through cache and opens no notification connection when CACHE_ENABLED is %s",
    async (cacheEnabled) => {
      const order: string[] = [];
      const server = {
        close: vi.fn((callback: (error?: Error) => void) => {
          order.push("server");
          callback();
        }),
      } as unknown as ServerType;
      const createNotificationAdapter = vi.fn(() => {
        throw new Error("notification adapter must not be created");
      });
      let composedCache: ReturnType<typeof createResponseCache> | undefined;
      const createApp = vi.fn((dependencies = {}) => {
        composedCache = dependencies.responseCache;
        return createHttpApp(dependencies);
      });

      const runtime = await startApi({
        loadEnv: () =>
          ({
            API_HOST: "127.0.0.1",
            PORT: 4312,
            CACHE_ENABLED: cacheEnabled,
            DATABASE_URL: "postgres://example",
          }) as Env,
        createHttpApp: createApp,
        serve: serveImmediately(server),
        closeDb: async () => void order.push("db"),
        createNotificationAdapter,
        installGracefulShutdown: () => () => undefined,
        startupLogger: { info: vi.fn(), error: vi.fn() },
      });
      let computes = 0;
      const key = {
        userId: "11111111-1111-4111-8111-111111111111",
        method: "GET" as const,
        route: "/accounts",
        query: {},
        revision: 0n,
      };

      await composedCache?.getOrCompute(key, async () => ++computes);
      await composedCache?.getOrCompute(key, async () => ++computes);
      await runtime.close();

      expect(computes).toBe(2);
      expect(composedCache?.stats().entries).toBe(0);
      expect(createNotificationAdapter).not.toHaveBeenCalled();
      expect(order).toEqual(["server", "db"]);
    },
  );

  it("owns the configured listener and closes it before the database exactly once", async () => {
    const order: string[] = [];
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        order.push("server");
        callback();
      }),
    } as unknown as ServerType;
    const gracefulShutdown = vi.fn(() => vi.fn());
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
    const startServer = vi.fn(
      serveImmediately(server, () => order.push("serve")),
    );
    const start = await startApi({
      loadEnv: vi.fn(
        () =>
          ({
            API_HOST: "100.64.0.42",
            PORT: 4312,
            CACHE_ENABLED: true,
          }) as Env,
      ),
      createHttpApp: vi.fn(createHttpApp),
      serve: startServer,
      closeDb,
      responseCache: createResponseCache(),
      createNotificationAdapter: () => notificationAdapter,
      installGracefulShutdown: gracefulShutdown,
      startupLogger: { info, error: vi.fn() },
    });

    expect(start.server).toBe(server);
    expect(startServer).toHaveBeenCalledWith(
      {
        fetch: expect.any(Function),
        hostname: "100.64.0.42",
        port: 4312,
      },
      expect.any(Function),
    );
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
      serve: serveImmediately(server),
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
      serve: serveImmediately(server),
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

  it("applies validated cache limits and owns the cleanup timer", async () => {
    const order: string[] = [];
    const configuration = {
      API_HOST: "127.0.0.1",
      PORT: 4312,
      CACHE_ENABLED: true,
      CACHE_TTL_MS: 123_456,
      CACHE_MAX_ENTRIES: 17,
      CACHE_MAX_BYTES: 32_768,
      CACHE_MAX_ENTRY_BYTES: 8_192,
    } as Env;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        order.push("server");
        callback();
      }),
    } as unknown as ServerType;
    let composedCache: ReturnType<typeof createResponseCache> | undefined;
    const stopCleanup = vi.fn(() => void order.push("cache"));
    let startCleanup: MockInstance | undefined;
    const createApp = vi.fn((dependencies = {}) => {
      composedCache = dependencies.responseCache;
      startCleanup = vi
        .spyOn(composedCache!, "startCleanup")
        .mockReturnValue(stopCleanup);
      return createHttpApp(dependencies);
    });

    const runtime = await startApi({
      loadEnv: () => configuration,
      createHttpApp: createApp,
      serve: serveImmediately(server),
      closeDb: async () => void order.push("db"),
      createNotificationAdapter: () => ({
        listen: async () => ({
          unlisten: async () => void order.push("unlisten"),
        }),
        close: async () => void order.push("notification"),
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    expect(composedCache?.stats()).toMatchObject({
      ttlMs: 123_456,
      maxEntries: 17,
      maxBytes: 32_768,
      maxEntryBytes: 8_192,
    });

    await runtime.close();

    expect(startCleanup).toHaveBeenCalledWith(60_000);
    expect(stopCleanup).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "server",
      "cache",
      "unlisten",
      "notification",
      "db",
    ]);
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
            CACHE_ENABLED: true,
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
          CACHE_ENABLED: true,
          DATABASE_URL: "postgres://example",
        }) as Env,
      serve: serveImmediately(server),
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

  it("does not report startup complete until the HTTP server is listening", async () => {
    const server = Object.assign(new EventEmitter(), {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    }) as unknown as ServerType;
    let reportListening: (() => void) | undefined;
    const startServer = vi.fn((_options, listening?: () => void) => {
      reportListening = listening;
      return server;
    }) as unknown as typeof serve;
    let settled = false;

    const startup = startApi({
      loadEnv: () =>
        ({
          API_HOST: "127.0.0.1",
          PORT: 4312,
          CACHE_ENABLED: true,
          DATABASE_URL: "postgres://example",
        }) as Env,
      serve: startServer,
      closeDb: async () => undefined,
      createNotificationAdapter: () => ({
        listen: async () => ({ unlisten: async () => undefined }),
        close: async () => undefined,
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    }).then((runtime) => {
      settled = true;
      return runtime;
    });

    await vi.waitFor(() =>
      expect(reportListening).toEqual(expect.any(Function)),
    );
    expect(settled).toBe(false);
    reportListening?.();
    const runtime = await startup;
    await runtime.close();
  });

  it("rejects an asynchronous bind failure and closes every owned resource", async () => {
    const bindError = Object.assign(new Error("address already in use"), {
      code: "EADDRINUSE",
    });
    const order: string[] = [];
    const server = Object.assign(new EventEmitter(), {
      close: vi.fn((callback: (error?: Error) => void) => {
        order.push("server");
        callback(
          Object.assign(new Error("not running"), {
            code: "ERR_SERVER_NOT_RUNNING",
          }),
        );
      }),
    }) as unknown as ServerType;

    const startup = startApi({
      loadEnv: () =>
        ({
          API_HOST: "127.0.0.1",
          PORT: 4312,
          CACHE_ENABLED: true,
          DATABASE_URL: "postgres://example",
        }) as Env,
      serve: (() => {
        queueMicrotask(() => {
          if (server.listenerCount("error") > 0)
            server.emit("error", bindError);
        });
        return server;
      }) as typeof serve,
      closeDb: async () => void order.push("db"),
      createNotificationAdapter: () => ({
        listen: async () => ({
          unlisten: async () => void order.push("unlisten"),
        }),
        close: async () => void order.push("notification"),
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    await expect(startup).rejects.toBe(bindError);
    expect(server.listenerCount("error")).toBe(0);
    expect(order).toEqual(["server", "unlisten", "notification", "db"]);
  });

  it("unregisters process signal handlers when manually closed", async () => {
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    } as unknown as ServerType;
    const runtime = await startApi({
      loadEnv: () =>
        ({
          API_HOST: "127.0.0.1",
          PORT: 4312,
          DATABASE_URL: "postgres://example",
        }) as Env,
      serve: serveImmediately(server),
      closeDb: async () => undefined,
      createNotificationAdapter: () => ({
        listen: async () => ({ unlisten: async () => undefined }),
        close: async () => undefined,
      }),
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    await runtime.close();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  });

  it("preserves a reasonless startup rejection with its cleanup failure", async () => {
    const cleanupError = new Error("notification cleanup failed");
    const failure = await startApi({
      loadEnv: () =>
        ({
          API_HOST: "127.0.0.1",
          PORT: 4312,
          CACHE_ENABLED: true,
          DATABASE_URL: "postgres://example",
        }) as Env,
      closeDb: async () => undefined,
      createInvalidationListener: () => ({
        start: () => Promise.reject(undefined),
        stop: async () => undefined,
      }),
      createNotificationAdapter: () => ({
        listen: async () => ({ unlisten: async () => undefined }),
        close: () => Promise.reject(cleanupError),
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      undefined,
      cleanupError,
    ]);
  });

  it.each(["shutdown installer", "startup logger"] as const)(
    "cleans every owned resource when the %s fails after bind",
    async (failurePoint) => {
      const startupError = new Error(`${failurePoint} failed`);
      const order: string[] = [];
      const server = {
        close: vi.fn((callback: (error?: Error) => void) => {
          order.push("server");
          callback();
        }),
      } as unknown as ServerType;
      const uninstall = vi.fn(() => void order.push("uninstall"));
      const failure = await startApi({
        loadEnv: () =>
          ({
            API_HOST: "127.0.0.1",
            PORT: 4312,
            CACHE_ENABLED: true,
            DATABASE_URL: "postgres://example",
          }) as Env,
        serve: serveImmediately(server),
        closeDb: async () => void order.push("db"),
        responseCache: {
          ...createResponseCache(),
          startCleanup: () => () => void order.push("cache"),
        },
        createNotificationAdapter: () => ({
          listen: async () => ({
            unlisten: async () => void order.push("unlisten"),
          }),
          close: async () => void order.push("notification"),
        }),
        installGracefulShutdown: () => {
          if (failurePoint === "shutdown installer") throw startupError;
          return uninstall;
        },
        startupLogger: {
          info: () => {
            if (failurePoint === "startup logger") throw startupError;
          },
          error: vi.fn(),
        },
      }).catch((error: unknown) => error);

      expect(failure).toBe(startupError);
      expect(order).toEqual([
        ...(failurePoint === "startup logger" ? ["uninstall"] : []),
        "server",
        "cache",
        "unlisten",
        "notification",
        "db",
      ]);
    },
  );
});
