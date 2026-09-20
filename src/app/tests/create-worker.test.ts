import { describe, expect, it, vi } from "vitest";
import { createWorker } from "../create-worker.js";

describe("createWorker", () => {
  it("builds the default runtime adapters when a worker identity is supplied", async () => {
    const adapter = { enabled: true, start: vi.fn(), stop: vi.fn() };
    const defaultAdapterFactory = vi.fn(() => [adapter]);
    const worker = createWorker({
      workerId: "worker-a",
      defaultAdapterFactory,
    });

    await worker.start();
    await worker.stop();

    expect(defaultAdapterFactory).toHaveBeenCalledWith("worker-a");
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it("does not schedule timers before or after starting its default shell", async () => {
    vi.useFakeTimers();
    const worker = createWorker();

    await worker.start();
    await worker.stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("runs enabled adapter sweeps in order and coalesces concurrent wakes", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = {
      enabled: true,
      sweep: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push("first");
            releaseFirst = resolve;
          }),
      ),
    };
    const disabled = { enabled: false, sweep: vi.fn() };
    const last = {
      enabled: true,
      sweep: vi.fn(async () => {
        order.push("last");
      }),
    };
    const worker = createWorker({ adapters: [first, disabled, last] });
    await worker.start();

    const firstWake = worker.wake();
    const concurrentWake = worker.wake();
    expect(concurrentWake).toBe(firstWake);
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    releaseFirst();
    await firstWake;

    expect(order).toEqual(["first", "last"]);
    expect(first.sweep).toHaveBeenCalledOnce();
    expect(last.sweep).toHaveBeenCalledOnce();
    expect(disabled.sweep).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("does not sweep before start or after stop", async () => {
    const sweep = vi.fn(async () => undefined);
    const worker = createWorker({ adapters: [{ enabled: true, sweep }] });

    await worker.wake();
    await worker.start();
    await worker.stop();
    await worker.wake();

    expect(sweep).not.toHaveBeenCalled();
  });

  it("reports the earliest retry deadline across enabled adapters", async () => {
    const later = new Date("2026-09-20T20:00:00.000Z");
    const earlier = new Date("2026-09-20T18:00:00.000Z");
    const worker = createWorker({
      adapters: [
        { enabled: true, nextWakeAt: async () => later },
        { enabled: false, nextWakeAt: async () => new Date(0) },
        { enabled: true, nextWakeAt: async () => earlier },
        { enabled: true, nextWakeAt: async () => null },
      ],
    });
    await worker.start();

    await expect(worker.nextWakeAt()).resolves.toEqual(earlier);
    await worker.stop();
  });

  it("starts enabled adapters once and stops them once in reverse order", async () => {
    const first = { enabled: true, start: vi.fn(), stop: vi.fn() };
    const disabled = { enabled: false, start: vi.fn(), stop: vi.fn() };
    const last = { enabled: true, start: vi.fn(), stop: vi.fn() };
    const worker = createWorker({ adapters: [first, disabled, last] });

    await worker.start();
    await worker.start();
    await worker.stop();
    await worker.stop();
    await worker.start();

    expect(first.start).toHaveBeenCalledTimes(1);
    expect(last.start).toHaveBeenCalledTimes(1);
    expect(disabled.start).not.toHaveBeenCalled();
    expect(disabled.stop).not.toHaveBeenCalled();
    expect(last.stop).toHaveBeenCalledTimes(1);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(last.stop.mock.invocationCallOrder[0]).toBeLessThan(
      first.stop.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("unwinds every entered adapter and preserves startup and cleanup failures", async () => {
    const order: string[] = [];
    const startFailure = new Error("second adapter failed to start");
    const cleanupFailure = new Error(
      "cleanup must not replace the start failure",
    );
    const first = {
      enabled: true,
      start: async () => {
        order.push("first:start");
      },
      stop: async () => {
        order.push("first:stop");
        throw cleanupFailure;
      },
    };
    const second = {
      enabled: true,
      start: async () => {
        order.push("second:start");
        throw startFailure;
      },
      stop: async () => {
        order.push("second:stop");
      },
    };

    const worker = createWorker({ adapters: [first, second] });

    const startResult = await worker.start().catch((error: unknown) => error);
    const stopResult = await worker.stop().catch((error: unknown) => error);
    expect(startResult).toBeInstanceOf(AggregateError);
    expect((startResult as AggregateError).errors).toEqual([
      startFailure,
      cleanupFailure,
    ]);
    expect(stopResult).toBe(startResult);
    expect(order).toEqual([
      "first:start",
      "second:start",
      "second:stop",
      "first:stop",
    ]);
  });

  it("preserves a reasonless startup rejection while unwinding", async () => {
    const order: string[] = [];
    const worker = createWorker({
      adapters: [
        {
          enabled: true,
          stop: async () => {
            order.push("first:stop");
          },
        },
        {
          enabled: true,
          start: () => Promise.reject(),
        },
      ],
    });

    await expect(worker.start()).rejects.toBeUndefined();
    await expect(worker.stop()).rejects.toBeUndefined();
    expect(order).toEqual(["first:stop"]);
  });

  it("attempts every stop in reverse order", async () => {
    const order: string[] = [];
    const firstStopFailure = new Error("last adapter stop failed");
    const first = {
      enabled: true,
      stop: async () => {
        order.push("first:stop");
      },
    };
    const middle = {
      enabled: true,
      stop: async () => {
        order.push("middle:stop");
        throw new Error("middle adapter stop failed");
      },
    };
    const last = {
      enabled: true,
      stop: async () => {
        order.push("last:stop");
        throw firstStopFailure;
      },
    };
    const worker = createWorker({ adapters: [first, middle, last] });

    await worker.start();
    const firstStop = worker.stop();
    const repeatedStop = worker.stop();

    expect(repeatedStop).toBe(firstStop);
    const failure = await firstStop.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      firstStopFailure,
      expect.objectContaining({ message: "middle adapter stop failed" }),
    ]);
    expect(order).toEqual(["last:stop", "middle:stop", "first:stop"]);
  });

  it("preserves every adapter stop failure", async () => {
    const lastFailure = new Error("last adapter stop failed");
    const firstFailure = new Error("first adapter stop failed");
    const worker = createWorker({
      adapters: [
        {
          enabled: true,
          stop: async () => {
            throw firstFailure;
          },
        },
        {
          enabled: true,
          stop: async () => {
            throw lastFailure;
          },
        },
      ],
    });

    await worker.start();
    const failure = await worker.stop().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      lastFailure,
      firstFailure,
    ]);
  });

  it("preserves separate stop failures even when they share one error object", async () => {
    const sharedFailure = new Error("shared stop failure");
    const worker = createWorker({
      adapters: [
        { enabled: true, stop: async () => Promise.reject(sharedFailure) },
        { enabled: true, stop: async () => Promise.reject(sharedFailure) },
      ],
    });

    await worker.start();
    const failure = await worker.stop().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      sharedFailure,
      sharedFailure,
    ]);
  });

  it("attempts every stop and preserves every reasonless rejection", async () => {
    const order: string[] = [];
    const worker = createWorker({
      adapters: [
        {
          enabled: true,
          stop: async () => {
            order.push("first:stop");
          },
        },
        {
          enabled: true,
          stop: () => {
            order.push("middle:stop");
            return Promise.reject(null);
          },
        },
        {
          enabled: true,
          stop: () => {
            order.push("last:stop");
            return Promise.reject();
          },
        },
      ],
    });

    await worker.start();
    const failure = await worker.stop().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([undefined, null]);
    expect(order).toEqual(["last:stop", "middle:stop", "first:stop"]);
  });

  it("shares concurrent lifecycle work and never restarts after stop", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const adapter = {
      enabled: true,
      start: vi.fn(() => startGate),
      stop: vi.fn(),
    };
    const worker = createWorker({ adapters: [adapter] });

    const firstStart = worker.start();
    const repeatedStart = worker.start();
    const stop = worker.stop();

    expect(repeatedStart).toBe(firstStart);
    releaseStart?.();
    await Promise.all([firstStart, stop]);
    await worker.start();
    await worker.stop();

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });
});
