import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../app/create-http-app.js";
import type { Env } from "../platform/config/env.js";
import { startApi } from "./api.js";

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
    const info = vi.fn();
    const startServer = vi.fn(() => server) as unknown as typeof serve;
    const start = startApi({
      loadEnv: vi.fn(() => ({ PORT: 4312 }) as Env),
      createHttpApp: vi.fn(createHttpApp),
      serve: startServer,
      closeDb,
      installGracefulShutdown: gracefulShutdown,
      startupLogger: { info, error: vi.fn() },
    });

    expect(start.server).toBe(server);
    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4312, fetch: expect.any(Function) }),
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

    expect(order).toEqual(["server", "db"]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
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

    const runtime = startApi({
      loadEnv: () => ({ PORT: 4312 }) as Env,
      serve: (() => server) as typeof serve,
      closeDb,
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(closeDb).toHaveBeenCalledTimes(1);
  });
});
