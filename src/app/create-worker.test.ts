import { describe, expect, it, vi } from "vitest";
import { createWorker } from "./create-worker.js";

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
});
