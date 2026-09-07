import {
  calculateRetryDelayMs,
  normalizeErrorCode,
  type ClaimedJob,
} from "./jobs.types.js";
import {
  createJobsRepository,
  type JobsRepository,
} from "./jobs.repository.js";
import { getDb } from "../database/client.js";
import { logger as defaultLogger } from "../logging/logger.js";

export type JobHandlerContext = Readonly<{
  jobId: string;
  leaseToken: string;
  workerId: string;
  signal: AbortSignal;
}>;
export type JobHandler = (
  payload: Record<string, unknown>,
  context: JobHandlerContext,
) => Promise<void>;
export type JobsPollerOptions = Readonly<{
  handlers: Readonly<Record<string, JobHandler | unknown>>;
  pollMs?: number;
  workerId: string;
  concurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  shutdownTimeoutMs?: number;
  random?: () => number;
  repository?: JobsRepository;
  clock?: () => number;
  logger?: Pick<typeof defaultLogger, "error" | "warn" | "debug">;
  setIntervalFn?: (
    handler: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  setTimeoutFn?: (
    handler: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
}>;

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function positiveInteger(
  value: number,
  name: string,
  fallback: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate <= 0)
    throw new RangeError(`${name} must be positive`);
  return Math.floor(candidate);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return normalizeErrorCode(code);
  }
  return "WORKER_FAILURE";
}

export function createJobsPoller(options: JobsPollerOptions): {
  start(): void;
  stop(): Promise<void>;
} {
  const pollMs = positiveInteger(options.pollMs ?? 15_000, "pollMs", 15_000);
  const concurrency = Math.min(
    positiveInteger(options.concurrency ?? 5, "concurrency", 5),
    100,
  );
  const leaseMs = positiveInteger(
    options.leaseMs ?? DEFAULT_LEASE_MS,
    "leaseMs",
    DEFAULT_LEASE_MS,
  );
  const heartbeatMs = positiveInteger(
    options.heartbeatMs ?? Math.floor(leaseMs / 2),
    "heartbeatMs",
    Math.floor(leaseMs / 2),
  );
  const shutdownTimeoutMs = Math.min(
    positiveInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs",
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ),
    leaseMs,
  );
  if (!options.workerId.trim()) throw new RangeError("workerId is required");

  const repository =
    options.repository ?? createJobsRepository({ db: getDb() });
  const clock = options.clock ?? Date.now;
  const pollerLogger = options.logger ?? defaultLogger;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fillPromise: Promise<void> | undefined;
  const active = new Map<Promise<void>, AbortController>();

  const runOne = async (
    job: ClaimedJob,
    controller: AbortController,
  ): Promise<void> => {
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let lostLease = false;
    try {
      const handler = options.handlers[job.type];
      if (typeof handler !== "function") {
        await repository.failJob(job.id, job.leaseToken, "MISSING_HANDLER");
        return;
      }
      if (!isPlainObject(job.payload)) {
        await repository.failJob(job.id, job.leaseToken, "INVALID_PAYLOAD");
        return;
      }
      heartbeatTimer = setIntervalFn(() => {
        void repository
          .heartbeatJob(job.id, job.leaseToken, leaseMs)
          .then((owned) => {
            if (!owned && !lostLease) {
              lostLease = true;
              controller.abort(new Error("job lease lost"));
              pollerLogger.warn({ jobId: job.id }, "job lease lost");
            }
          })
          .catch((error: unknown) =>
            pollerLogger.error(
              { jobId: job.id, error },
              "job heartbeat failed",
            ),
          );
      }, heartbeatMs);
      await handler(job.payload, {
        jobId: job.id,
        leaseToken: job.leaseToken,
        workerId: options.workerId,
        signal: controller.signal,
      });
      if (lostLease || stopping) return;
      const completed = await repository.completeJob(job.id, job.leaseToken);
      if (!completed) {
        lostLease = true;
        controller.abort(new Error("job lease lost before completion"));
        pollerLogger.warn({ jobId: job.id }, "job completion lost lease");
      }
    } catch (error: unknown) {
      pollerLogger.error(
        { jobId: job.id, type: job.type, error },
        "job handler failed",
      );
      if (lostLease) return;
      const code = errorCode(error);
      if (job.attempts >= job.maxAttempts)
        await repository.failJob(job.id, job.leaseToken, code);
      else
        await repository.retryJob(
          job.id,
          job.leaseToken,
          code,
          new Date(
            clock() + calculateRetryDelayMs(job.attempts, options.random),
          ),
        );
    } finally {
      if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
    }
  };

  const fill = async (): Promise<void> => {
    if (fillPromise) return fillPromise;
    fillPromise = (async () => {
      try {
        while (!stopping && active.size < concurrency) {
          const claimed = await repository.claimJobs(
            options.workerId,
            concurrency - active.size,
            leaseMs,
          );
          if (claimed.length === 0) break;
          for (const job of claimed) {
            if (stopping) continue;
            const controller = new AbortController();
            const work = runOne(job, controller);
            active.set(work, controller);
            void work
              .catch((error: unknown) =>
                pollerLogger.error(
                  { jobId: job.id, error },
                  "job execution failed",
                ),
              )
              .finally(() => {
                active.delete(work);
                if (!stopping) void fill();
              });
          }
        }
      } catch (error: unknown) {
        pollerLogger.error({ error }, "job claim failed");
      } finally {
        fillPromise = undefined;
      }
    })();
    return fillPromise;
  };

  return {
    start(): void {
      if (started || stopping) return;
      started = true;
      void fill();
      timer = setIntervalFn(() => void fill(), pollMs);
    },
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      if (timer) clearIntervalFn(timer);
      for (const controller of active.values())
        controller.abort(new Error("worker stopping"));
      if (fillPromise) await fillPromise;
      await Promise.race([
        Promise.all([...active.keys()]),
        new Promise<void>((resolve) =>
          setTimeoutFn(resolve, shutdownTimeoutMs),
        ),
      ]);
    },
  };
}
