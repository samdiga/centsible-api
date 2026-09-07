export type JobStatus = "pending" | "running" | "completed" | "failed";

export type Job = {
  id: string;
  userId: string | null;
  type: string;
  payload: unknown;
  status: JobStatus;
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

export type ClaimedJob = Job & {
  status: "running";
  lockedBy: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  startedAt: Date;
  lastHeartbeatAt: Date;
};

export type EnqueueJobInput = Readonly<{
  type: string;
  payload: unknown;
  userId?: string | null;
  scheduledFor?: Date;
  maxAttempts?: number;
  /** Optional caller-supplied key for active-work deduplication. */
  uniqueActiveKey?: string;
}>;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const MAX_CLAIM_LIMIT = 100;

/** Safe error identifiers are intentionally incapable of carrying messages or stack traces. */
export const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_.-]{0,63}$/;

export function normalizeErrorCode(value: string): string {
  const code = value.trim().toUpperCase();
  return SAFE_ERROR_CODE.test(code) ? code : "WORKER_FAILURE";
}

/** Calculates the bounded 30-second exponential retry delay with 0-25% jitter. */
export function calculateRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new RangeError("attempt must be a positive integer");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError("random source must return a number between 0 and 1");
  }
  const base = Math.min(30_000 * 2 ** (attempt - 1), 60 * 60_000);
  return Math.floor(base * (1 + 0.25 * sample));
}
