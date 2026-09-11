import type { DbTransaction } from "../database/types.js";
import { enqueueJob as defaultEnqueueJob } from "./jobs.repository.js";
import type { EnqueueJobInput, Job } from "./jobs.types.js";
import {
  createPipelineRepository,
  type PipelineRepository,
} from "../../modules/pipeline/pipeline.repository.js";
import type { PipelineService } from "../../modules/pipeline/pipeline.service.js";
import { logger } from "../logging/logger.js";

export const SYSTEM_SCHEDULES = [
  {
    scheduleKey: "raw_imports_purge",
    jobType: "plaid_raw_imports_purge",
    payload: { kind: "all" },
    hour: 3,
    minute: 0,
  },
  {
    scheduleKey: "retention_purge",
    jobType: "retention_purge",
    payload: { kind: "daily" },
    hour: 3,
    minute: 10,
  },
  {
    scheduleKey: "forecast_accuracy",
    jobType: "compute_forecast_accuracy",
    payload: { kind: "daily" },
    hour: 3,
    minute: 20,
  },
] as const;

export function localParts(
  now: Date,
  timeZone: string,
): { date: string; hour: number; minute: number } {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    format.formatToParts(now).map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export type SchedulerLogger = Readonly<{
  warn: (
    bindings: Record<string, unknown>,
    message: string,
  ) => void | PromiseLike<void>;
  error: (
    bindings: Record<string, unknown>,
    message: string,
  ) => void | PromiseLike<void>;
}>;
export type ScheduleRepository = Pick<
  PipelineRepository,
  "listEnabledSchedules" | "dispatchSchedule"
>;
export type Scheduler = Readonly<{
  start: () => void;
  stop: () => Promise<void>;
  tickOnce: (now?: Date) => Promise<void>;
}>;

export function createScheduler(
  dependencies: Readonly<{
    schedules?: ScheduleRepository;
    enqueue?: (
      input: EnqueueJobInput,
      tx: DbTransaction,
    ) => Promise<{ job: Pick<Job, "id">; deduped: boolean }>;
    dispatchPipeline?: (
      userId: string,
      tx: DbTransaction,
    ) => Promise<{ runId: string | null; deduped: boolean }>;
    pipelineService?: Pick<PipelineService, "startPipelineRunInTransaction">;
    clock?: { now: () => Date };
    intervalMs?: number;
    shutdownTimeoutMs?: number;
    tick?: (now: Date) => Promise<void>;
    logger?: SchedulerLogger;
    ensureSystemSchedules?: () => Promise<void>;
    ensureUserSchedules?: () => Promise<void>;
    reapExpiredJobs?: () => Promise<void | ReadonlyArray<{
      type: string;
      status: string;
      payload: unknown;
    }>>;
    finishPipelineRun?: (runId: string, status: "failed") => Promise<void>;
  }> = {},
): Scheduler {
  let schedules = dependencies.schedules;
  const enqueue =
    dependencies.enqueue ?? ((input, tx) => defaultEnqueueJob(input, tx));
  const dispatchPipeline =
    dependencies.dispatchPipeline ??
    ((userId, tx) => {
      if (!dependencies.pipelineService)
        throw new Error("Pipeline dispatcher unavailable");
      return dependencies.pipelineService.startPipelineRunInTransaction(
        { userId, trigger: "scheduled" },
        tx,
      );
    });
  const clock = dependencies.clock ?? { now: () => new Date() };
  const intervalMs = dependencies.intervalMs ?? 60_000;
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 30_000;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0)
    throw new RangeError("shutdownTimeoutMs must be a positive integer");
  const log = dependencies.logger ?? logger;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let bootstrap: Promise<void> | undefined;
  let systemSchedulesReady = !dependencies.ensureSystemSchedules;
  let userSchedulesReady = !dependencies.ensureUserSchedules;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  const stoppedDuringDispatch = new Error("scheduler stopping");

  const ensureSchedules = (): Promise<void> => {
    if (bootstrap) return bootstrap;
    bootstrap = Promise.all([
      systemSchedulesReady
        ? Promise.resolve()
        : Promise.resolve()
            .then(dependencies.ensureSystemSchedules)
            .then(() => {
              systemSchedulesReady = true;
            })
            .catch((error) =>
              log.error({ error }, "system schedule bootstrap failed"),
            ),
      userSchedulesReady
        ? Promise.resolve()
        : Promise.resolve()
            .then(dependencies.ensureUserSchedules)
            .then(() => {
              userSchedulesReady = true;
            })
            .catch((error) =>
              log.error({ error }, "user schedule bootstrap failed"),
            ),
    ])
      .then(() => undefined)
      .finally(() => {
        bootstrap = undefined;
      });
    return bootstrap;
  };

  const runTick = async (now: Date): Promise<void> => {
    await ensureSchedules();
    if (stopping) return;
    if (!schedules) {
      if (dependencies.tick) return;
      schedules = createPipelineRepository();
    }
    if (dependencies.reapExpiredJobs) {
      try {
        const reaped = await dependencies.reapExpiredJobs();
        if (reaped && dependencies.finishPipelineRun) {
          for (const job of reaped) {
            if (job.type !== "sync_pipeline" || job.status !== "failed")
              continue;
            const payload = job.payload;
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            )
              continue;
            const runId = (payload as Record<string, unknown>).runId;
            if (typeof runId === "string")
              await dependencies.finishPipelineRun(runId, "failed");
          }
        }
      } catch (error) {
        await log.error({ error }, "scheduler job reaping failed");
      }
    }
    const rows = await schedules.listEnabledSchedules();
    for (const schedule of rows) {
      if (stopping) break;
      try {
        let local: { date: string; hour: number; minute: number };
        try {
          local = localParts(now, schedule.timezone);
        } catch (error) {
          await log.warn(
            { scheduleId: schedule.id, timezone: schedule.timezone, error },
            "invalid timezone; falling back to UTC",
          );
          local = localParts(now, "UTC");
        }
        if (
          local.hour < schedule.hour ||
          (local.hour === schedule.hour && local.minute < schedule.minute)
        )
          continue;
        if (
          schedule.lastDispatchedFor !== null &&
          schedule.lastDispatchedFor >= local.date
        )
          continue;
        await schedules.dispatchSchedule(
          schedule.id,
          local.date,
          async (tx) => {
            if (stopping) throw stoppedDuringDispatch;
            if (
              schedule.scheduleKey === "daily_sync_pipeline" &&
              schedule.userId
            ) {
              await dispatchPipeline(schedule.userId, tx);
              if (stopping) throw stoppedDuringDispatch;
              return;
            }
            const system = SYSTEM_SCHEDULES.find(
              (item) => item.scheduleKey === schedule.scheduleKey,
            );
            if (!system) throw new Error("Unknown scheduler key");
            await enqueue(
              { type: system.jobType, payload: system.payload },
              tx,
            );
            if (stopping) throw stoppedDuringDispatch;
          },
        );
      } catch (error) {
        if (error === stoppedDuringDispatch) break;
        await log.error(
          { scheduleId: schedule.id, scheduleKey: schedule.scheduleKey, error },
          "schedule dispatch failed",
        );
      }
    }
  };
  const tickOnce = (now = clock.now()): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = runTick(now).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const start = (): void => {
    if (timer || stopPromise) return;
    void ensureSchedules();
    timer = setInterval(() => {
      if (dependencies.tick) {
        if (inFlight) return;
        inFlight = ensureSchedules()
          .then(() => (stopping ? undefined : dependencies.tick!(clock.now())))
          .catch((error) => log.error({ error }, "scheduler tick failed"))
          .finally(() => {
            inFlight = undefined;
          });
        return;
      }
      void tickOnce().catch((error) =>
        log.error({ error }, "scheduler tick failed"),
      );
    }, intervalMs);
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const activeWork = Promise.all([
      bootstrap ?? Promise.resolve(),
      inFlight ?? Promise.resolve(),
    ]).then(() => undefined);
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, shutdownTimeoutMs);
    });
    stopPromise = Promise.race([activeWork, deadline]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    return stopPromise;
  };
  return { start, stop, tickOnce };
}

export const startScheduler = (
  options: Parameters<typeof createScheduler>[0] = {},
): Scheduler => {
  const scheduler = createScheduler(options);
  scheduler.start();
  return scheduler;
};
