import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../database/client.js";
import type { Db, DbTransaction } from "../database/types.js";
import {
  calculateRetryDelayMs,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_CLAIM_LIMIT,
  normalizeErrorCode,
  type ClaimedJob,
  type EnqueueJobInput,
  type Job,
} from "./jobs.types.js";

type RawJob = {
  id: string;
  userId: string | null;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  maxAttempts: number;
  scheduledFor: Date;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lockedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
};

export type JobsRepository = Readonly<{
  enqueueJob(input: EnqueueJobInput): Promise<{ job: Job; deduped: boolean }>;
  claimJobs(
    workerId: string,
    limit: number,
    leaseMs?: number,
  ): Promise<ClaimedJob[]>;
  completeJob(id: string, leaseToken: string): Promise<boolean>;
  retryJob(
    id: string,
    leaseToken: string,
    errorCode: string,
    availableAt: Date,
  ): Promise<boolean>;
  failJob(id: string, leaseToken: string, errorCode: string): Promise<boolean>;
  heartbeatJob(
    id: string,
    leaseToken: string,
    leaseMs?: number,
  ): Promise<boolean>;
  releaseJob(id: string, leaseToken: string): Promise<boolean>;
  reapExpiredJobs(now?: Date): Promise<number>;
}>;

export type JobsRepositoryDependencies = Readonly<{
  db: Db;
  now?: () => Date;
  createLeaseToken?: () => string;
  onTerminalExpiredJob?: (
    job: Pick<Job, "id" | "type" | "payload" | "status">,
    tx: DbTransaction,
  ) => Promise<void>;
}>;

function toJob(row: RawJob): Job {
  if (!["pending", "running", "completed", "failed"].includes(row.status)) {
    throw new Error("Database returned an invalid job status");
  }
  return { ...row, status: row.status as Job["status"] };
}

function toClaimedJob(row: RawJob): ClaimedJob {
  const job = toJob(row);
  if (
    job.status !== "running" ||
    !job.lockedBy ||
    !job.leaseToken ||
    !job.leaseExpiresAt ||
    !job.startedAt ||
    !job.lastHeartbeatAt
  ) {
    throw new Error("Claimed job is missing lease fields");
  }
  return {
    ...job,
    status: "running",
    lockedBy: job.lockedBy,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt,
    startedAt: job.startedAt,
    lastHeartbeatAt: job.lastHeartbeatAt,
  };
}

function newLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

function validateLeaseMs(leaseMs: number): number {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new RangeError("leaseMs must be a positive integer");
  }
  return leaseMs;
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }
  return Math.min(limit, MAX_CLAIM_LIMIT);
}

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

async function findActiveByKey(
  type: string,
  key: string,
  database: Db | DbTransaction,
): Promise<Job | undefined> {
  const rows = await database.execute<RawJob>(sql`
    SELECT
      id, user_id AS "userId", type, payload, status, attempts,
      max_attempts AS "maxAttempts", scheduled_for AS "scheduledFor",
      started_at AS "startedAt", last_heartbeat_at AS "lastHeartbeatAt",
      locked_by AS "lockedBy", lease_token AS "leaseToken",
      lease_expires_at AS "leaseExpiresAt", completed_at AS "completedAt",
      error_code AS "errorCode", created_at AS "createdAt"
    FROM jobs
    WHERE type = ${type}
      AND status IN ('pending', 'running')
      AND payload->>'userId' = ${key}
      AND user_id = ${key}
    ORDER BY id
    LIMIT 1
  `);
  const matching = rows.find((row) => {
    if (
      row.userId !== key ||
      typeof row.payload !== "object" ||
      row.payload === null ||
      Array.isArray(row.payload)
    )
      return false;
    return (row.payload as Record<string, unknown>).userId === key;
  });
  return matching ? toJob(matching) : undefined;
}

export async function enqueueJob(
  input: EnqueueJobInput,
  database?: Db | DbTransaction,
  now: () => Date = () => new Date(),
): Promise<{ job: Job; deduped: boolean }> {
  if (!input.type.trim()) throw new RangeError("job type is required");
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  const payloadRecord =
    typeof input.payload === "object" &&
    input.payload !== null &&
    !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : undefined;
  const activeKey =
    input.type === "sync_pipeline" && typeof payloadRecord?.userId === "string"
      ? payloadRecord.userId
      : undefined;
  if (input.type === "sync_pipeline") {
    if (
      !activeKey ||
      !canonicalUuid.test(activeKey) ||
      activeKey !== activeKey.toLowerCase()
    ) {
      throw new RangeError(
        "sync_pipeline payload.userId must be a canonical UUID",
      );
    }
    if (
      input.userId !== undefined &&
      input.userId !== null &&
      input.userId !== activeKey
    ) {
      throw new RangeError(
        "sync_pipeline userId does not match payload.userId",
      );
    }
  }
  const payload =
    activeKey && payloadRecord
      ? { ...payloadRecord, userId: activeKey }
      : input.payload;
  const db = database ?? getDb();

  if (activeKey) {
    const existing = await findActiveByKey(input.type, activeKey, db);
    if (existing) return { job: existing, deduped: true };
  }

  const values = {
    type: input.type,
    payload,
    userId: activeKey ?? input.userId ?? null,
    scheduledFor: input.scheduledFor ?? now(),
    maxAttempts,
    status: "pending" as const,
  };

  if (activeKey) {
    const rows = await db.execute<RawJob>(sql`
      INSERT INTO jobs (
        user_id, type, payload, status, attempts, max_attempts, scheduled_for
      )
      VALUES (
        ${values.userId}, ${values.type}, ${JSON.stringify(values.payload)}::jsonb,
        'pending', 0, ${values.maxAttempts}, ${values.scheduledFor.toISOString()}::timestamptz
      )
      ON CONFLICT ((payload->>'userId'))
      WHERE type = 'sync_pipeline' AND status IN ('pending', 'running')
      DO NOTHING
      RETURNING
        id, user_id AS "userId", type, payload, status, attempts,
        max_attempts AS "maxAttempts", scheduled_for AS "scheduledFor",
        started_at AS "startedAt", last_heartbeat_at AS "lastHeartbeatAt",
        locked_by AS "lockedBy", lease_token AS "leaseToken",
        lease_expires_at AS "leaseExpiresAt", completed_at AS "completedAt",
        error_code AS "errorCode", created_at AS "createdAt"
    `);
    const row = rows[0];
    if (row) return { job: toJob(row as unknown as RawJob), deduped: false };
    const existing = await findActiveByKey(input.type, activeKey, db);
    if (!existing)
      throw new Error("Active sync conflict did not resolve to a job");
    return { job: existing, deduped: true };
  }

  const [row] = await db.insert(schema.jobs).values(values).returning();
  if (!row) throw new Error("Job insert returned no row");
  return { job: toJob(row as unknown as RawJob), deduped: false };
}

export async function claimJobs(
  workerId: string,
  limit: number,
  leaseMs: number = DEFAULT_LEASE_MS,
  database?: Db,
  createToken: () => string = newLeaseToken,
): Promise<ClaimedJob[]> {
  if (!workerId.trim()) throw new RangeError("workerId is required");
  const boundedLimit = validateLimit(limit);
  const boundedLease = validateLeaseMs(leaseMs);
  const db = database ?? getDb();
  return db.transaction(async (tx) => {
    const selected = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM jobs
      WHERE (
        (status = 'pending' AND scheduled_for <= now())
        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
      AND attempts < max_attempts
      ORDER BY scheduled_for ASC, id ASC
      LIMIT ${boundedLimit}
      FOR UPDATE SKIP LOCKED
    `);
    const claimed: ClaimedJob[] = [];
    for (const row of selected) {
      const token = createToken();
      const [updated] = await tx
        .update(schema.jobs)
        .set({
          status: "running",
          attempts: sql`${schema.jobs.attempts} + 1`,
          lockedBy: workerId,
          leaseToken: token,
          leaseExpiresAt: sql`now() + (${boundedLease} * interval '1 millisecond')`,
          startedAt: sql`now()`,
          lastHeartbeatAt: sql`now()`,
          completedAt: null,
          errorCode: null,
        })
        .where(eq(schema.jobs.id, row.id))
        .returning();
      if (updated) claimed.push(toClaimedJob(updated as unknown as RawJob));
    }
    return claimed;
  });
}

export async function completeJob(
  id: string,
  leaseToken: string,
  database?: Db,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const db = database ?? getDb();
  const [row] = await db
    .update(schema.jobs)
    .set({
      status: "completed",
      completedAt: now(),
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.jobs.id, id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, leaseToken),
      ),
    )
    .returning({ id: schema.jobs.id });
  return row !== undefined;
}

export async function retryJob(
  id: string,
  leaseToken: string,
  errorCode: string,
  availableAt: Date,
  database?: Db,
): Promise<boolean> {
  const safeCode = normalizeErrorCode(errorCode);
  const db = database ?? getDb();
  const [row] = await db
    .update(schema.jobs)
    .set({
      status: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN 'failed' ELSE 'pending' END`,
      scheduledFor: availableAt,
      errorCode: safeCode,
      completedAt: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN now() ELSE NULL END`,
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.jobs.id, id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, leaseToken),
      ),
    )
    .returning({ id: schema.jobs.id });
  return row !== undefined;
}

export async function failJob(
  id: string,
  leaseToken: string,
  errorCode: string,
  database?: Db,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const db = database ?? getDb();
  const [row] = await db
    .update(schema.jobs)
    .set({
      status: "failed",
      errorCode: normalizeErrorCode(errorCode),
      completedAt: now(),
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.jobs.id, id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, leaseToken),
      ),
    )
    .returning({ id: schema.jobs.id });
  return row !== undefined;
}

export async function heartbeatJob(
  id: string,
  leaseToken: string,
  leaseMs: number = DEFAULT_LEASE_MS,
  database?: Db,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const boundedLease = validateLeaseMs(leaseMs);
  const db = database ?? getDb();
  const [row] = await db
    .update(schema.jobs)
    .set({
      lastHeartbeatAt: now(),
      leaseExpiresAt: sql`now() + (${boundedLease} * interval '1 millisecond')`,
    })
    .where(
      and(
        eq(schema.jobs.id, id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, leaseToken),
      ),
    )
    .returning({ id: schema.jobs.id });
  return row !== undefined;
}

/** Releases a claim only before handler execution; handlers must never call this. */
export async function releaseJob(
  id: string,
  leaseToken: string,
  database?: Db,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const db = database ?? getDb();
  const [row] = await db
    .update(schema.jobs)
    .set({
      status: "pending",
      scheduledFor: now(),
      attempts: sql`GREATEST(${schema.jobs.attempts} - 1, 0)`,
      startedAt: null,
      lastHeartbeatAt: null,
      completedAt: null,
      errorCode: null,
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.jobs.id, id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, leaseToken),
      ),
    )
    .returning({ id: schema.jobs.id });
  return row !== undefined;
}

export async function reapExpiredJobs(
  now: Date = new Date(),
  database?: Db,
  onTerminalExpiredJob?: JobsRepositoryDependencies["onTerminalExpiredJob"],
): Promise<number> {
  const db = database ?? getDb();
  const reap = async (executor: Db | DbTransaction) =>
    executor
      .update(schema.jobs)
      .set({
        status: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN 'failed' ELSE 'pending' END`,
        scheduledFor: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN ${schema.jobs.scheduledFor} ELSE ${now.toISOString()}::timestamptz END`,
        errorCode: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN 'LEASE_EXPIRED' ELSE ${schema.jobs.errorCode} END`,
        completedAt: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN ${now.toISOString()}::timestamptz ELSE NULL END`,
        lockedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(schema.jobs.status, "running"),
          sql`${schema.jobs.leaseExpiresAt} IS NOT NULL AND ${schema.jobs.leaseExpiresAt} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .returning({
        id: schema.jobs.id,
        type: schema.jobs.type,
        payload: schema.jobs.payload,
        status: schema.jobs.status,
      });
  if (!onTerminalExpiredJob) return (await reap(db)).length;
  return db.transaction(async (tx) => {
    const rows = await reap(tx);
    for (const row of rows) {
      if (row.status === "failed")
        await onTerminalExpiredJob({ ...row, status: "failed" }, tx);
    }
    return rows.length;
  });
}

/** Binds database, clock, and token generation for deterministic callers/tests. */
export function createJobsRepository(
  dependencies: JobsRepositoryDependencies,
): JobsRepository {
  const now = dependencies.now ?? (() => new Date());
  const createToken = dependencies.createLeaseToken ?? newLeaseToken;
  return {
    enqueueJob: (input) => enqueueJob(input, dependencies.db, now),
    claimJobs: (workerId, limit, leaseMs) =>
      claimJobs(workerId, limit, leaseMs, dependencies.db, createToken),
    completeJob: (id, token) => completeJob(id, token, dependencies.db, now),
    retryJob: (id, token, code, availableAt) =>
      retryJob(id, token, code, availableAt, dependencies.db),
    failJob: (id, token, code) =>
      failJob(id, token, code, dependencies.db, now),
    heartbeatJob: (id, token, leaseMs) =>
      heartbeatJob(id, token, leaseMs, dependencies.db, now),
    releaseJob: (id, token) => releaseJob(id, token, dependencies.db, now),
    reapExpiredJobs: (at) =>
      reapExpiredJobs(at, dependencies.db, dependencies.onTerminalExpiredJob),
  };
}

export { calculateRetryDelayMs, isUniqueViolation };
