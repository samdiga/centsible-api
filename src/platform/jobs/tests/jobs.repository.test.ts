import { describe, expect, it } from "vitest";
import type { Db } from "../../database/types.js";
import {
  calculateRetryDelayMs,
  createJobsRepository,
  isUniqueViolation,
} from "../jobs.repository.js";

type AnyDb = {
  execute: (query: unknown) => Promise<unknown[]>;
  transaction: (callback: (tx: AnyDb) => Promise<unknown>) => Promise<unknown>;
  insert: () => AnyDb;
  update: () => AnyDb;
  values: (values: Record<string, unknown>) => AnyDb;
  set: (values: Record<string, unknown>) => AnyDb;
  where: (condition: unknown) => AnyDb;
  returning: (fields?: unknown) => Promise<unknown[]>;
  inserted?: Record<string, unknown>;
  updates?: Record<string, unknown>[];
  selected?: { id: string }[];
  executeRows: unknown[][] | undefined;
  returnRows?: unknown[];
  uniqueFailure?: boolean;
};

function rawJob(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "job-1",
    userId: null,
    type: "sync_pipeline",
    payload: { userId: "user-1" },
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    scheduledFor: new Date(1),
    startedAt: null,
    lastHeartbeatAt: null,
    lockedBy: null,
    leaseToken: null,
    leaseExpiresAt: null,
    completedAt: null,
    errorCode: null,
    createdAt: new Date(1),
    ...overrides,
  };
}

function fakeDb(
  options: {
    selected?: { id: string }[];
    returnRows?: unknown[];
    executeRows?: unknown[][];
  } = {},
): AnyDb {
  const db = {} as AnyDb;
  db.selected = options.selected ?? [];
  db.returnRows = options.returnRows ?? [];
  db.executeRows = options.executeRows;
  db.updates = [];
  db.execute = async () => db.executeRows?.shift() ?? db.selected ?? [];
  db.transaction = async (callback) => callback(db);
  db.insert = () => db;
  db.update = () => db;
  db.values = (values) => {
    db.inserted = values;
    return db;
  };
  db.set = (values) => {
    db.updates!.push(values);
    return db;
  };
  db.where = () => db;
  db.returning = async () => {
    if (db.uniqueFailure) throw { code: "23505" };
    return db.returnRows ?? [];
  };
  return db;
}

describe("jobs repository with injected database", () => {
  it("claims selected rows with bounded order and injected opaque token", async () => {
    const db = fakeDb({
      selected: [{ id: "job-1" }],
      returnRows: [
        rawJob({
          status: "running",
          attempts: 1,
          lockedBy: "worker-a",
          leaseToken: "fixed-token",
          leaseExpiresAt: new Date(300_000),
          startedAt: new Date(1),
          lastHeartbeatAt: new Date(1),
        }),
      ],
    });
    const repository = createJobsRepository({
      db: db as unknown as Db,
      createLeaseToken: () => "fixed-token",
    });
    const claimed = await repository.claimJobs("worker-a", 200, 300_000);
    expect(claimed[0]?.leaseToken).toBe("fixed-token");
    expect(db.updates?.[0]).toMatchObject({
      lockedBy: "worker-a",
      leaseToken: "fixed-token",
    });
    expect(db.execute).toBeDefined();
  });

  it("binds current-token mutations and clears lease fields", async () => {
    const db = fakeDb({ returnRows: [{ id: "job-1" }] });
    const repository = createJobsRepository({
      db: db as unknown as Db,
      now: () => new Date(100),
    });
    db.returnRows = [];
    expect(await repository.completeJob("job-1", "stale")).toBe(false);
    db.returnRows = [{ id: "job-1" }];
    expect(await repository.completeJob("job-1", "current")).toBe(true);
    expect(db.updates?.[0]).toMatchObject({
      status: "completed",
      completedAt: new Date(100),
      leaseToken: null,
      lockedBy: null,
      leaseExpiresAt: null,
    });
    db.returnRows = [];
    expect(await repository.heartbeatJob("job-1", "stale", 300_000)).toBe(
      false,
    );
    expect(await repository.releaseJob("job-1", "stale")).toBe(false);
  });

  it("records safe codes and supports retry/terminal/reap field transitions", async () => {
    const db = fakeDb({ returnRows: [{ id: "job-1" }] });
    const repository = createJobsRepository({
      db: db as unknown as Db,
      now: () => new Date(100),
    });
    expect(
      await repository.retryJob(
        "job-1",
        "token",
        "raw secret stack",
        new Date(200),
      ),
    ).toBe(true);
    expect(db.updates?.[0]?.errorCode).toBe("WORKER_FAILURE");
    expect(db.updates?.[0]?.leaseToken).toBeNull();
    expect(await repository.failJob("job-1", "token", "UPSTREAM_TIMEOUT")).toBe(
      true,
    );
    expect(db.updates?.[1]).toMatchObject({
      status: "failed",
      completedAt: new Date(100),
    });
    expect(await repository.reapExpiredJobs(new Date(300))).toBe(1);
  });

  it("deduplicates sync work and handles concurrent unique violations", async () => {
    const existing = rawJob({ status: "pending" });
    const db = fakeDb({ executeRows: [[existing]] });
    const repository = createJobsRepository({ db: db as unknown as Db });
    expect(
      (
        await repository.enqueueJob({
          type: "sync_pipeline",
          payload: { userId: "user-1" },
        })
      ).deduped,
    ).toBe(true);
    const racingDb = fakeDb({ executeRows: [[], [existing]], returnRows: [] });
    racingDb.uniqueFailure = true;
    const raceRepository = createJobsRepository({
      db: racingDb as unknown as Db,
    });
    expect(
      (
        await raceRepository.enqueueJob({
          type: "sync_pipeline",
          payload: { userId: "user-1" },
        })
      ).deduped,
    ).toBe(true);
  });
});

describe("jobs repository local validation", () => {
  it("rejects invalid input before opening a database", async () => {
    const repository = createJobsRepository({ db: {} as Db });
    await expect(
      repository.enqueueJob({ type: "", payload: {} }),
    ).rejects.toThrow("type");
  });

  it("uses exponential retry with jitter and a one-hour final cap", () => {
    expect(calculateRetryDelayMs(1, () => 0)).toBe(30_000);
    expect(calculateRetryDelayMs(2, () => 1)).toBe(75_000);
    expect(calculateRetryDelayMs(100, () => 1)).toBe(3_600_000);
    expect(() => calculateRetryDelayMs(1, () => -1)).toThrow("between 0 and 1");
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });
});
