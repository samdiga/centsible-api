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
