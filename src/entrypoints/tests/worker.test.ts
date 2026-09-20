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
      wake: vi.fn(async () => undefined),
      nextWakeAt: vi.fn(async () => null),
    };
    const createWorker = vi.fn(() => worker);
    const closeDb = vi.fn(async () => {
      order.push("db");
    });
    const uninstallShutdown = vi.fn();
    const gracefulShutdown = vi.fn(() => uninstallShutdown);
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
    expect(uninstallShutdown).toHaveBeenCalledOnce();
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

  it("attempts every owned shutdown action and preserves every failure", async () => {
    const order: string[] = [];
    const workerFailure = new Error("worker stop failed");
    const databaseFailure = new Error("database close failed");
    const worker: WorkerRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        order.push("worker");
        throw workerFailure;
      }),
      wake: vi.fn(async () => undefined),
      nextWakeAt: vi.fn(async () => null),
    };
    const uninstallShutdown = vi.fn(() => order.push("signals"));
    const runtime = await startWorker({
      loadEnv: vi.fn(() => ({ PORT: 4312, WORKER_ID: "worker-a" }) as Env),
      createWorker: vi.fn(() => worker),
      closeDb: vi.fn(async () => {
        order.push("db");
        throw databaseFailure;
      }),
      installGracefulShutdown: vi.fn(() => uninstallShutdown),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    const failure = await runtime.close().catch((error: unknown) => error);

    expect(order).toEqual(["signals", "worker", "db"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      workerFailure,
      databaseFailure,
    ]);
  });

  it("stops the worker and closes the database when worker startup fails", async () => {
    const order: string[] = [];
    const startFailure = new Error("worker start failed");
    const worker: WorkerRuntime = {
      start: vi.fn(async () => {
        throw startFailure;
      }),
      stop: vi.fn(async () => {
        order.push("worker");
      }),
      wake: vi.fn(async () => undefined),
      nextWakeAt: vi.fn(async () => null),
    };

    await expect(
      startWorker({
        loadEnv: vi.fn(() => ({ PORT: 4312, WORKER_ID: "worker-a" }) as Env),
        createWorker: vi.fn(() => worker),
        closeDb: vi.fn(async () => {
          order.push("db");
        }),
        installGracefulShutdown: vi.fn(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toBe(startFailure);
    expect(order).toEqual(["worker", "db"]);
  });

  it("cleans started resources when shutdown installation fails", async () => {
    const order: string[] = [];
    const installFailure = new Error("signal installation failed");
    const worker: WorkerRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        order.push("worker");
      }),
      wake: vi.fn(async () => undefined),
      nextWakeAt: vi.fn(async () => null),
    };

    await expect(
      startWorker({
        loadEnv: vi.fn(() => ({ PORT: 4312, WORKER_ID: "worker-a" }) as Env),
        createWorker: vi.fn(() => worker),
        closeDb: vi.fn(async () => {
          order.push("db");
        }),
        installGracefulShutdown: vi.fn(() => {
          throw installFailure;
        }),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toBe(installFailure);
    expect(order).toEqual(["worker", "db"]);
  });

  it("does not duplicate a real worker startup aggregate during entrypoint cleanup", async () => {
    const startFailure = new Error("adapter start failed");
    const stopFailure = new Error("adapter stop failed");

    const failure = await startWorker({
      loadEnv: vi.fn(() => ({ PORT: 4312, WORKER_ID: "worker-a" }) as Env),
      adapters: [
        {
          enabled: true,
          start: async () => Promise.reject(startFailure),
          stop: async () => Promise.reject(stopFailure),
        },
      ],
      closeDb: vi.fn(async () => undefined),
      installGracefulShutdown: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn() },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      startFailure,
      stopFailure,
    ]);
  });

  it("coalesces startup and control wakes and schedules the earliest retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    let requestWake!: () => void | Promise<void>;
    const wake = vi.fn(async () => undefined);
    const worker: WorkerRuntime = {
      start: vi.fn(async () => undefined),
      wake,
      nextWakeAt: vi.fn(async () => new Date("2026-09-20T13:00:00.000Z")),
      stop: vi.fn(async () => undefined),
    };
    const wakeServer = {
      start: vi.fn(async () => "http://127.0.0.1:4011/wake"),
      stop: vi.fn(async () => undefined),
    };

    const runtime = await startWorker({
      loadEnv: vi.fn(
        () =>
          ({
            WORKER_ID: "worker-a",
            WORKER_WAKE_URL: "http://127.0.0.1:4011/wake",
            WORKER_SWEEP_INTERVAL_MINUTES: 360,
          }) as Env,
      ),
      createWorker: vi.fn(() => worker),
      createWakeServer: vi.fn((options) => {
        requestWake = options.wake;
        return wakeServer;
      }),
      closeDb: vi.fn(async () => undefined),
      installGracefulShutdown: vi.fn(() => vi.fn()),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(wake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await requestWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(wake).toHaveBeenCalledTimes(3);

    await runtime.close();
    expect(wakeServer.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("runs a follow-up sweep when a wake arrives during an active sweep", async () => {
    let requestWake!: () => void | Promise<void>;
    let releaseFirstSweep!: () => void;
    const firstSweep = new Promise<void>((resolve) => {
      releaseFirstSweep = resolve;
    });
    const wake = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstSweep)
      .mockResolvedValue(undefined);
    const worker: WorkerRuntime = {
      start: vi.fn(async () => undefined),
      wake,
      nextWakeAt: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };
    const runtime = await startWorker({
      loadEnv: vi.fn(
        () =>
          ({
            WORKER_ID: "worker-a",
            WORKER_WAKE_URL: "http://127.0.0.1:4011/wake",
            WORKER_SWEEP_INTERVAL_MINUTES: 360,
          }) as Env,
      ),
      createWorker: vi.fn(() => worker),
      createWakeServer: vi.fn((options) => {
        requestWake = options.wake;
        return {
          start: async () => "http://127.0.0.1:4011/wake",
          stop: async () => undefined,
        };
      }),
      closeDb: vi.fn(async () => undefined),
      installGracefulShutdown: vi.fn(() => vi.fn()),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    expect(wake).toHaveBeenCalledOnce();

    const followUp = requestWake();
    releaseFirstSweep();
    await followUp;

    expect(wake).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("uses no periodic timer when sweeps are disabled and no retry exists", async () => {
    vi.useFakeTimers();
    const worker: WorkerRuntime = {
      start: vi.fn(async () => undefined),
      wake: vi.fn(async () => undefined),
      nextWakeAt: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };
    const runtime = await startWorker({
      loadEnv: vi.fn(
        () =>
          ({
            WORKER_ID: "worker-a",
            WORKER_WAKE_URL: "http://127.0.0.1:4011/wake",
            WORKER_SWEEP_INTERVAL_MINUTES: 0,
          }) as Env,
      ),
      createWorker: vi.fn(() => worker),
      createWakeServer: vi.fn(() => ({
        start: async () => "http://127.0.0.1:4011/wake",
        stop: async () => undefined,
      })),
      closeDb: vi.fn(async () => undefined),
      installGracefulShutdown: vi.fn(() => vi.fn()),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(worker.wake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await runtime.close();
    vi.useRealTimers();
  });

  it("retains the periodic fallback when reading retry deadlines fails", async () => {
    vi.useFakeTimers();
    const retryFailure = new Error("retry deadline unavailable");
    const worker: WorkerRuntime = {
      start: vi.fn(async () => undefined),
      wake: vi.fn(async () => undefined),
      nextWakeAt: vi.fn(async () => Promise.reject(retryFailure)),
      stop: vi.fn(async () => undefined),
    };
    const error = vi.fn();
    const runtime = await startWorker({
      loadEnv: vi.fn(
        () =>
          ({
            WORKER_ID: "worker-a",
            WORKER_WAKE_URL: "http://127.0.0.1:4011/wake",
            WORKER_SWEEP_INTERVAL_MINUTES: 360,
          }) as Env,
      ),
      createWorker: vi.fn(() => worker),
      createWakeServer: vi.fn(() => ({
        start: async () => "http://127.0.0.1:4011/wake",
        stop: async () => undefined,
      })),
      closeDb: vi.fn(async () => undefined),
      installGracefulShutdown: vi.fn(() => vi.fn()),
      logger: { info: vi.fn(), error },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(error).toHaveBeenCalledWith(
      { error: retryFailure },
      "Worker sweep scheduling failed",
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(360 * 60_000);
    expect(worker.wake).toHaveBeenCalledTimes(2);

    await runtime.close();
    vi.useRealTimers();
  });
});
