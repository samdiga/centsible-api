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
  appliedUpdates?: Record<string, unknown>[];
  pendingUpdate?: Record<string, unknown>;
  selected?: { id: string }[];
  executeRows: unknown[][] | undefined;
  returnRows?: unknown[];
  uniqueFailure?: boolean | unknown;
};

function rawJob(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "job-1",
    userId: "11111111-1111-4111-8111-111111111111",
    type: "sync_pipeline",
    payload: { userId: "11111111-1111-4111-8111-111111111111" },
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
  db.appliedUpdates = [];
  db.execute = async () => db.executeRows?.shift() ?? db.selected ?? [];
  db.transaction = async (callback) => callback(db);
  db.insert = () => db;
  db.update = () => db;
  db.values = (values) => {
    db.inserted = values;
    return db;
  };
  db.set = (values) => {
    db.pendingUpdate = values;
    db.updates!.push(values);
    return db;
  };
  db.where = () => db;
  db.returning = async () => {
    if (db.uniqueFailure)
      throw db.uniqueFailure === true ? { code: "23505" } : db.uniqueFailure;
    const rows = db.returnRows ?? [];
    if (rows.length > 0 && db.pendingUpdate) {
      db.appliedUpdates!.push(db.pendingUpdate);
    }
    return rows;
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

  it("rolls back an unstarted claim exactly once when releasing it", async () => {
    const db = fakeDb({ returnRows: [{ id: "job-1" }] });
    const repository = createJobsRepository({
      db: db as unknown as Db,
      now: () => new Date(100),
    });
    expect(await repository.releaseJob("job-1", "current")).toBe(true);
    expect(db.updates?.[0]).toMatchObject({
      status: "pending",
      scheduledFor: new Date(100),
      startedAt: null,
      lastHeartbeatAt: null,
      completedAt: null,
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: null,
    });
    expect(db.updates?.[0]?.attempts).toEqual(expect.anything());

    db.returnRows = [];
    expect(await repository.releaseJob("job-1", "stale")).toBe(false);
    expect(db.appliedUpdates).toHaveLength(1);
  });

  it("deduplicates sync work with a conflict-safe insert", async () => {
    const existing = rawJob({ status: "pending" });
    const db = fakeDb({ executeRows: [[existing]] });
    const repository = createJobsRepository({ db: db as unknown as Db });
    expect(
      (
        await repository.enqueueJob({
          type: "sync_pipeline",
          payload: { userId: "11111111-1111-4111-8111-111111111111" },
        })
      ).deduped,
    ).toBe(true);
    const racingDb = fakeDb({
      executeRows: [[], [], [existing]],
      returnRows: [],
    });
    const raceRepository = createJobsRepository({
      db: racingDb as unknown as Db,
    });
    expect(
      (
        await raceRepository.enqueueJob({
          type: "sync_pipeline",
          payload: { userId: "11111111-1111-4111-8111-111111111111" },
        })
      ).deduped,
    ).toBe(true);
  });

  it("uses the canonical sync payload tenant when input userId is omitted or null", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const db = fakeDb({ executeRows: [[], [rawJob({ userId })]] });
    const repository = createJobsRepository({ db: db as unknown as Db });
    const result = await repository.enqueueJob({
      type: "sync_pipeline",
      payload: { userId },
      userId: null,
    });
    expect(result.job.userId).toBe(userId);
    await expect(
      repository.enqueueJob({
        type: "sync_pipeline",
        payload: { userId },
        userId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow("does not match");
  });

  it("does not deduplicate against an active row owned by another tenant", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const foreignUserId = "22222222-2222-4222-8222-222222222222";
    const db = fakeDb({
      executeRows: [
        [
          rawJob({
            userId: foreignUserId,
            payload: { userId },
          }),
          rawJob({
            userId,
            payload: { userId: foreignUserId },
          }),
        ],
        [rawJob({ userId })],
      ],
    });
    const repository = createJobsRepository({ db: db as unknown as Db });
    const result = await repository.enqueueJob({
      type: "sync_pipeline",
      payload: { userId },
    });
    expect(result.deduped).toBe(false);
    expect(result.job.userId).toBe(userId);
  });
});

describe("jobs repository local validation", () => {
  it("rejects invalid input before opening a database", async () => {
    const repository = createJobsRepository({ db: {} as Db });
    await expect(
      repository.enqueueJob({ type: "", payload: {} }),
    ).rejects.toThrow("type");
  });

  it("rejects fractional lease durations instead of rounding them", async () => {
    const repository = createJobsRepository({ db: {} as Db });
    await expect(repository.claimJobs("worker", 1, 1.5)).rejects.toThrow(
      "leaseMs",
    );
    await expect(
      repository.heartbeatJob("job-1", "token", 1.5),
    ).rejects.toThrow("leaseMs");
  });

  it("uses exponential retry with jitter and a one-hour final cap", () => {
    expect(calculateRetryDelayMs(1, () => 0)).toBe(30_000);
    expect(calculateRetryDelayMs(2, () => 1)).toBe(75_000);
    expect(calculateRetryDelayMs(100, () => 1)).toBe(3_600_000);
    expect(() => calculateRetryDelayMs(1, () => -1)).toThrow("between 0 and 1");
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("recognizes bounded, cycle-safe unique-violation causes only", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(
      isUniqueViolation({ code: "QUERY_FAILED", cause: { code: "23505" } }),
    ).toBe(true);
    expect(
      isUniqueViolation({
        code: "QUERY_FAILED",
        cause: { code: "WRAPPED", cause: { code: "23505" } },
      }),
    ).toBe(true);
    expect(isUniqueViolation({ code: "23503", cause: { code: "23505" } })).toBe(
      true,
    );
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ code: "23505x" })).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation({ code: "QUERY_FAILED", cause: 23505 })).toBe(
      false,
    );
    const cyclic: { code: string; cause?: unknown } = { code: "QUERY_FAILED" };
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });
});
