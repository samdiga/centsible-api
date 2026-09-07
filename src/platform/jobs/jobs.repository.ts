import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../database/client.js";
import type { Db } from "../database/types.js";
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
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new RangeError("leaseMs must be positive");
  }
  return Math.floor(leaseMs);
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }
  return Math.min(limit, MAX_CLAIM_LIMIT);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function findActiveByKey(
  type: string,
  key: string,
  database: Db,
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
    ORDER BY id
    LIMIT 1
  `);
  return rows[0] ? toJob(rows[0]) : undefined;
}

export async function enqueueJob(
  input: EnqueueJobInput,
  database: Db = getDb(),
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
    input.uniqueActiveKey ??
    (input.type === "sync_pipeline" && typeof payloadRecord?.userId === "string"
      ? payloadRecord.userId
      : undefined);
  const payload =
    activeKey && payloadRecord
      ? { ...payloadRecord, userId: activeKey }
      : input.payload;

  if (activeKey) {
    const existing = await findActiveByKey(input.type, activeKey, database);
    if (existing) return { job: existing, deduped: true };
  }

  try {
    const [row] = await database
      .insert(schema.jobs)
      .values({
        type: input.type,
        payload,
        userId: input.userId ?? null,
        scheduledFor: input.scheduledFor ?? new Date(),
        maxAttempts,
        status: "pending",
      })
      .returning();
    if (!row) throw new Error("Job insert returned no row");
    return { job: toJob(row as unknown as RawJob), deduped: false };
  } catch (error: unknown) {
    if (!activeKey || !isUniqueViolation(error)) throw error;
    const existing = await findActiveByKey(input.type, activeKey, database);
    if (!existing) throw error;
    return { job: existing, deduped: true };
  }
}

export async function claimJobs(
  workerId: string,
  limit: number,
  leaseMs: number = DEFAULT_LEASE_MS,
  database: Db = getDb(),
): Promise<ClaimedJob[]> {
  if (!workerId.trim()) throw new RangeError("workerId is required");
  const boundedLimit = validateLimit(limit);
  const boundedLease = validateLeaseMs(leaseMs);
  return database.transaction(async (tx) => {
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
      const token = newLeaseToken();
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
  database: Db = getDb(),
): Promise<boolean> {
  const [row] = await database
    .update(schema.jobs)
    .set({
      status: "completed",
      completedAt: new Date(),
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
  database: Db = getDb(),
): Promise<boolean> {
  const safeCode = normalizeErrorCode(errorCode);
  const [row] = await database
    .update(schema.jobs)
    .set({
      status: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN 'failed' ELSE 'pending' END`,
      scheduledFor: availableAt,
      errorCode: safeCode,
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
  database: Db = getDb(),
): Promise<boolean> {
  const [row] = await database
    .update(schema.jobs)
    .set({
      status: "failed",
      errorCode: normalizeErrorCode(errorCode),
      completedAt: new Date(),
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
  database: Db = getDb(),
): Promise<boolean> {
  const boundedLease = validateLeaseMs(leaseMs);
  const [row] = await database
    .update(schema.jobs)
    .set({
      lastHeartbeatAt: new Date(),
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

export async function releaseJob(
  id: string,
  leaseToken: string,
  database: Db = getDb(),
): Promise<boolean> {
  const [row] = await database
    .update(schema.jobs)
    .set({
      status: "pending",
      scheduledFor: new Date(),
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
  database: Db = getDb(),
): Promise<number> {
  const rows = await database
    .update(schema.jobs)
    .set({
      status: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN 'failed' ELSE 'pending' END`,
      scheduledFor: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN ${schema.jobs.scheduledFor} ELSE ${now} END`,
      errorCode: sql`CASE WHEN ${schema.jobs.attempts} >= ${schema.jobs.maxAttempts} THEN 'LEASE_EXPIRED' ELSE ${schema.jobs.errorCode} END`,
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.jobs.status, "running"),
        sql`${schema.jobs.leaseExpiresAt} IS NOT NULL AND ${schema.jobs.leaseExpiresAt} <= ${now}`,
      ),
    )
    .returning({ id: schema.jobs.id });
  return rows.length;
}

export { calculateRetryDelayMs, isUniqueViolation };
