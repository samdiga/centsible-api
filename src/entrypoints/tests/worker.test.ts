import { describe, expect, it, vi } from "vitest";
import type { WorkerRuntime } from "../../app/create-worker.js";
import type { Env } from "../../platform/config/env.js";
import { startWorker } from "../worker.js";

describe("startWorker", () => {
  it("starts only the worker role and stops it before the database exactly once", async () => {
    const order: string[] = [];
    const worker: WorkerRuntime = {
      start: vi.fn(async () => {
        order.push("start");
      }),
      stop: vi.fn(async () => {
        order.push("worker");
      }),
    };
    const createWorker = vi.fn(() => worker);
    const closeDb = vi.fn(async () => {
      order.push("db");
    });
    const gracefulShutdown = vi.fn((close: () => Promise<void>) => close);
    const info = vi.fn();

    const runtime = await startWorker({
      loadEnv: vi.fn(() => ({ PORT: 4312 }) as Env),
      createWorker,
      closeDb,
      installGracefulShutdown: gracefulShutdown,
      logger: { info, error: vi.fn() },
    });
    await runtime.close();
    await runtime.close();

    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["start", "worker", "db"]);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(gracefulShutdown).toHaveBeenCalledWith(runtime.close);
    expect(Object.keys(info.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "revision",
      "role",
      "service",
    ]);
    expect(info).toHaveBeenCalledWith(
      { service: "centsible-api", role: "worker", revision: "unknown" },
      "Worker started",
    );
  });
});
