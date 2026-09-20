import { expect, it, vi } from "vitest";
import { createWorkerSweepAdapters } from "../default-worker-adapters.js";
import { createWorker } from "../create-worker.js";

it("sweeps schedules, inbound events, then jobs without starting poll timers", async () => {
  const order: string[] = [];
  const scheduler = {
    start: vi.fn(),
    tickOnce: vi.fn(async () => void order.push("scheduler")),
    stop: vi.fn(async () => void order.push("scheduler:stop")),
  };
  const inbound = {
    start: vi.fn(),
    pollOnce: vi.fn(),
    drainOnce: vi.fn(async () => void order.push("inbound")),
    nextWakeAt: vi.fn(async () => null),
    stop: vi.fn(async () => void order.push("inbound:stop")),
  };
  const jobs = {
    start: vi.fn(),
    drainOnce: vi.fn(async () => void order.push("jobs")),
    nextWakeAt: vi.fn(async () => null),
    stop: vi.fn(async () => void order.push("jobs:stop")),
  };
  const worker = createWorker({
    adapters: createWorkerSweepAdapters({ scheduler, inbound, jobs }),
  });

  await worker.start();
  await worker.wake();
  await worker.stop();

  expect(order).toEqual([
    "scheduler",
    "inbound",
    "jobs",
    "jobs:stop",
    "inbound:stop",
    "scheduler:stop",
  ]);
  expect(scheduler.start).not.toHaveBeenCalled();
  expect(inbound.start).not.toHaveBeenCalled();
  expect(jobs.start).not.toHaveBeenCalled();
});
