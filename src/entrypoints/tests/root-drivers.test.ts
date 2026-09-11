import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../app/create-http-app.js";
import type { Env } from "../../platform/config/env.js";
import { runApiDriver } from "../../../entrypoints/api.js";
import { runWorkerDriver } from "../../../entrypoints/worker.js";

describe("root entrypoint drivers", () => {
  it("delegates API startup through the root executable facade", async () => {
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    } as unknown as ServerType;
    const startServer = vi.fn((_options, listening?: () => void) => {
      listening?.();
      return server;
    }) as unknown as typeof serve;

    const runtime = await runApiDriver({
      loadEnv: () => ({ PORT: 4312 }) as Env,
      createHttpApp,
      serve: startServer,
      closeDb: async () => undefined,
      createNotificationAdapter: () => ({
        listen: async () => ({ unlisten: async () => undefined }),
        close: async () => undefined,
      }),
      installGracefulShutdown: () => () => undefined,
      startupLogger: { info: vi.fn(), error: vi.fn() },
    });

    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4312, fetch: expect.any(Function) }),
      expect.any(Function),
    );
    await runtime.close();
  });

  it("delegates worker startup through the root executable facade", async () => {
    const worker = { start: vi.fn(), stop: vi.fn() };

    const runtime = await runWorkerDriver({
      loadEnv: () => ({ PORT: 4312 }) as Env,
      createWorker: () => worker,
      closeDb: async () => undefined,
      installGracefulShutdown: () => () => undefined,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(worker.start).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(worker.stop).toHaveBeenCalledTimes(1);
  });
});
