import { expect, it, vi } from "vitest";
import type { DbTransaction } from "../../database/types.js";
import { createScheduler, localParts } from "../scheduler.js";

it("computes local calendar parts and validates timezone", () => {
  expect(
    localParts(new Date("2026-01-01T14:00:00Z"), "America/New_York"),
  ).toEqual({
    date: "2026-01-01",
    hour: 9,
    minute: 0,
  });
  expect(() => localParts(new Date(), "Mars/Olympus")).toThrow();
});

it("does not overlap ticks and stop shares an awaited in-flight promise", async () => {
  let release!: () => void;
  let active = 0;
  let maximum = 0;
  const tick = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        active += 1;
        maximum = Math.max(maximum, active);
        release = () => {
          active -= 1;
          resolve();
        };
      }),
  );
  const scheduler = createScheduler({ tick, intervalMs: 1 });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const first = scheduler.stop();
  const second = scheduler.stop();
  expect(first).toBe(second);
  release();
  await first;
  expect(maximum).toBe(1);
});

it("waits for schedule bootstrap before shutdown completes", async () => {
  let finishBootstrap!: () => void;
  const ensureSystemSchedules = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishBootstrap = resolve;
      }),
  );
  const scheduler = createScheduler({
    tick: async () => undefined,
    ensureSystemSchedules,
  });

  scheduler.start();
  const stopping = scheduler.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(stopped).toBe(false);
  finishBootstrap();
  await stopping;
});

it("bounds shutdown when a scheduler tick does not finish", async () => {
  vi.useFakeTimers();
  const scheduler = createScheduler({
    tick: () => new Promise<never>(() => undefined),
    intervalMs: 1,
    shutdownTimeoutMs: 10,
  });

  scheduler.start();
  await vi.advanceTimersByTimeAsync(1);
  const stopping = scheduler.stop();
  await vi.advanceTimersByTimeAsync(10);

  await expect(stopping).resolves.toBeUndefined();
  vi.useRealTimers();
});

it("rolls back a schedule dispatch that resumes after shutdown times out", async () => {
  vi.useFakeTimers();
  let releaseEnqueue!: () => void;
  let dispatchCommitted = false;
  const enqueue = vi.fn(
    () =>
      new Promise<{ job: { id: string }; deduped: boolean }>((resolve) => {
        releaseEnqueue = () =>
          resolve({ job: { id: "job-1" }, deduped: false });
      }),
  );
  const scheduler = createScheduler({
    schedules: {
      listEnabledSchedules: vi.fn(async () => [
        {
          id: "schedule-1",
          userId: null,
          scheduleKey: "raw_imports_purge",
          hour: 0,
          minute: 0,
          timezone: "UTC",
          enabled: true,
          lastDispatchedFor: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      dispatchSchedule: vi.fn(async (_id, _date, dispatch) => {
        await dispatch({} as DbTransaction);
        dispatchCommitted = true;
        return true;
      }),
    },
    enqueue,
    shutdownTimeoutMs: 10,
    logger: { error: vi.fn(), warn: vi.fn() },
  });

  const tick = scheduler.tickOnce(new Date("2026-01-01T01:00:00Z"));
  await vi.advanceTimersByTimeAsync(0);
  const stopping = scheduler.stop();
  await vi.advanceTimersByTimeAsync(10);
  await stopping;
  releaseEnqueue();
  await tick;

  expect(enqueue).toHaveBeenCalledOnce();
  expect(dispatchCommitted).toBe(false);
  vi.useRealTimers();
});

it("retries schedule bootstrap after a transient failure", async () => {
  vi.useFakeTimers();
  const ensureSystemSchedules = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValue(undefined);
  const scheduler = createScheduler({
    tick: async () => undefined,
    ensureSystemSchedules,
    intervalMs: 10,
    logger: { error: vi.fn(), warn: vi.fn() },
  });

  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10);

  expect(ensureSystemSchedules).toHaveBeenCalledTimes(2);
  await scheduler.stop();
  vi.useRealTimers();
});

it("does not restart after shutdown", async () => {
  vi.useFakeTimers();
  const tick = vi.fn(async () => undefined);
  const scheduler = createScheduler({ tick, intervalMs: 10 });

  scheduler.start();
  await scheduler.stop();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(10);

  expect(tick).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("does not run manual ticks after shutdown", async () => {
  const listEnabledSchedules = vi.fn(async () => []);
  const scheduler = createScheduler({
    schedules: {
      listEnabledSchedules,
      dispatchSchedule: vi.fn(async () => false),
    },
  });

  await scheduler.stop();
  await scheduler.tickOnce();

  expect(listEnabledSchedules).not.toHaveBeenCalled();
});

it("dispatches system schedules through the transaction callback", async () => {
  const dispatchSchedule = vi.fn(
    async (
      _id: string,
      _date: string,
      callback: (tx: DbTransaction) => Promise<void>,
    ) => {
      await callback({} as DbTransaction);
      return true;
    },
  );
  const enqueue = vi.fn(async () => ({ job: { id: "job-1" }, deduped: false }));
  const scheduler = createScheduler({
    schedules: {
      listEnabledSchedules: async () => [
        {
          id: "schedule-1",
          userId: null,
          scheduleKey: "raw_imports_purge",
          hour: 3,
          minute: 0,
          timezone: "UTC",
          enabled: true,
          lastDispatchedFor: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      dispatchSchedule,
    },
    enqueue,
  });
  await scheduler.tickOnce(new Date("2026-01-01T04:00:00Z"));
  expect(dispatchSchedule).toHaveBeenCalledWith(
    "schedule-1",
    "2026-01-01",
    expect.any(Function),
  );
  expect(enqueue).toHaveBeenCalledWith(
    { type: "plaid_raw_imports_purge", payload: { kind: "all" } },
    expect.anything(),
  );
});
