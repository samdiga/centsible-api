import { describe, expect, it, vi } from "vitest";
import { createWorker } from "../create-worker.js";

describe("createWorker", () => {
  it("does not schedule timers before or after starting its default shell", async () => {
    vi.useFakeTimers();
    const worker = createWorker();

    await worker.start();
    await worker.stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
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

  it("unwinds started adapters in reverse order when a later start fails", async () => {
    const order: string[] = [];
    const startFailure = new Error("second adapter failed to start");
    const first = {
      enabled: true,
      start: async () => {
        order.push("first:start");
      },
      stop: async () => {
        order.push("first:stop");
        throw new Error("cleanup must not replace the start failure");
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

    await expect(worker.start()).rejects.toBe(startFailure);
    await expect(worker.stop()).rejects.toBe(startFailure);
    expect(order).toEqual(["first:start", "second:start", "first:stop"]);
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

  it("attempts every stop and preserves the first stop failure", async () => {
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
    await expect(firstStop).rejects.toBe(firstStopFailure);
    expect(order).toEqual(["last:stop", "middle:stop", "first:stop"]);
  });

  it("attempts every stop and preserves a reasonless rejection", async () => {
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
    await expect(worker.stop()).rejects.toBeUndefined();
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
