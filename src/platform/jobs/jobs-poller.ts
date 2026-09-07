import {
  calculateRetryDelayMs,
  normalizeErrorCode,
  type ClaimedJob,
} from "./jobs.types.js";
import {
  claimJobs,
  completeJob,
  failJob,
  heartbeatJob,
  releaseJob,
  retryJob,
} from "./jobs.repository.js";
import { logger } from "../logging/logger.js";

export type JobHandlerContext = Readonly<{
  jobId: string;
  leaseToken: string;
  workerId: string;
}>;
export type JobHandler = (
  payload: unknown,
  context: JobHandlerContext,
) => Promise<void>;

export type JobsPollerOptions = Readonly<{
  handlers: Readonly<Record<string, JobHandler>>;
  pollMs?: number;
  workerId: string;
  concurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  random?: () => number;
}>;

const pollerLogger = logger.child({ component: "jobs-poller" });

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return normalizeErrorCode(code);
  }
  return "WORKER_FAILURE";
}

async function terminalFailure(job: ClaimedJob, code: string): Promise<void> {
  await failJob(job.id, job.leaseToken, code);
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
    options.leaseMs ?? 5 * 60_000,
    "leaseMs",
    5 * 60_000,
  );
  const heartbeatMs = positiveInteger(
    options.heartbeatMs ?? Math.floor(leaseMs / 2),
    "heartbeatMs",
    Math.floor(leaseMs / 2),
  );
  if (!options.workerId.trim()) throw new RangeError("workerId is required");

  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fillPromise: Promise<void> | undefined;
  const active = new Set<Promise<void>>();

  const runOne = async (job: ClaimedJob): Promise<void> => {
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const handler = options.handlers[job.type];
      if (!handler) {
        await terminalFailure(job, "MISSING_HANDLER");
        return;
      }
      if (!isRecord(job.payload)) {
        await terminalFailure(job, "INVALID_PAYLOAD");
        return;
      }
      heartbeatTimer = setInterval(() => {
        void heartbeatJob(job.id, job.leaseToken, leaseMs).catch(
          (error: unknown) => {
            pollerLogger.error(
              { jobId: job.id, error },
              "job heartbeat failed",
            );
          },
        );
      }, heartbeatMs);
      await handler(job.payload, {
        jobId: job.id,
        leaseToken: job.leaseToken,
        workerId: options.workerId,
      });
      await completeJob(job.id, job.leaseToken);
    } catch (error: unknown) {
      pollerLogger.error(
        { jobId: job.id, type: job.type, error },
        "job handler failed",
      );
      const code = errorCode(error);
      if (job.attempts >= job.maxAttempts) {
        await terminalFailure(job, code);
      } else {
        const availableAt = new Date(
          Date.now() + calculateRetryDelayMs(job.attempts, options.random),
        );
        await retryJob(job.id, job.leaseToken, code, availableAt);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  };

  const fill = async (): Promise<void> => {
    if (fillPromise) return fillPromise;
    fillPromise = (async () => {
      try {
        while (!stopping && active.size < concurrency) {
          const slots = concurrency - active.size;
          const claimed = await claimJobs(options.workerId, slots, leaseMs);
          if (claimed.length === 0) break;
          for (const job of claimed) {
            if (stopping) {
              await releaseJob(job.id, job.leaseToken);
              continue;
            }
            const work = runOne(job);
            active.add(work);
            void work
              .catch((error: unknown) => {
                pollerLogger.error(
                  { jobId: job.id, error },
                  "job execution failed",
                );
              })
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
      timer = setInterval(() => void fill(), pollMs);
    },
    async stop(): Promise<void> {
      if (stopping) {
        if (fillPromise) await fillPromise;
        await Promise.all([...active]);
        return;
      }
      stopping = true;
      if (timer) clearInterval(timer);
      if (fillPromise) await fillPromise;
      await Promise.all([...active]);
    },
  };
}
