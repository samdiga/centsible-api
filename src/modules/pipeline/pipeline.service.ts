import { randomUUID } from "node:crypto";
import { getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import {
  ServiceUnavailableError,
  ValidationError,
} from "../../platform/errors/app-error.js";
import { logger } from "../../platform/logging/logger.js";
import { redactLogValue } from "../../platform/logging/redaction.js";
import { enqueueJob as defaultEnqueueJob } from "../../platform/jobs/jobs.repository.js";
import type { EnqueueJobInput, Job } from "../../platform/jobs/jobs.types.js";
import { toPipelineRunDto } from "./pipeline.mapper.js";
import {
  createPipelineRepository,
  type PipelineRepository,
  type PipelineTrigger,
  type StepStats,
  type SyncScheduleRow,
} from "./pipeline.repository.js";
import {
  PipelineJobPayloadSchema,
  type PipelineJobPayload,
  type SyncSchedule,
  UpdateSyncScheduleBodySchema,
} from "./pipeline.schemas.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";

export const SYNC_PIPELINE_JOB = "sync_pipeline";
export const DAILY_SYNC_SCHEDULE_KEY = "daily_sync_pipeline";
export const PIPELINE_STEPS = [
  "plaid_sync",
  "liabilities_sync",
  "bill_detect",
  "bill_materialize",
  "overdue_sweep",
  "reconcile",
  "balance_refresh",
  "net_worth_snapshot",
  "budget_check",
] as const;
export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

export class PipelineStageError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly terminal = false,
  ) {
    super(message);
    this.name = "PipelineStageError";
  }
}

export type PipelineStagePort = (ctx: {
  userId: string;
}) => Promise<Record<string, unknown>>;
export type PipelineStagePorts = Partial<
  Readonly<{
    plaidSync: PipelineStagePort;
    liabilitiesSync: PipelineStagePort;
    billDetect: PipelineStagePort;
    billMaterialize: PipelineStagePort;
    overdueSweep: PipelineStagePort;
    reconcile: PipelineStagePort;
    balanceRefresh: PipelineStagePort;
    netWorthSnapshot: PipelineStagePort;
    budgetCheck: PipelineStagePort;
  }>
>;

export type JobEnqueuer = (
  input: EnqueueJobInput,
  tx: DbTransaction,
) => Promise<{ job: Pick<Job, "id">; deduped: boolean }>;
export type PipelineLogger = Readonly<{
  error: (
    bindings: Record<string, unknown>,
    message: string,
  ) => void | PromiseLike<void>;
  warn?: (
    bindings: Record<string, unknown>,
    message: string,
  ) => void | PromiseLike<void>;
}>;

export type PipelineService = Readonly<{
  startPipelineRun: (args: {
    userId: string;
    trigger: PipelineTrigger;
  }) => Promise<{ runId: string | null; deduped: boolean }>;
  startPipelineRunInTransaction: (
    args: { userId: string; trigger: PipelineTrigger },
    tx: DbTransaction,
  ) => Promise<{ runId: string | null; deduped: boolean }>;
  executePipelineJob: (
    payload: Record<string, unknown>,
    ctx: { jobId: string; leaseToken: string; signal: AbortSignal },
  ) => Promise<void>;
  listRuns: (
    userId: string,
    limit: number,
  ) => Promise<ReturnType<typeof toPipelineRunDto>[]>;
  getRun: (
    userId: string,
    runId: string,
  ) => Promise<ReturnType<typeof toPipelineRunDto> | null>;
  getSchedule: (userId: string) => Promise<SyncSchedule>;
  upsertSchedule: (
    userId: string,
    input: SyncSchedule,
  ) => Promise<SyncSchedule>;
}>;

export const DEFAULT_SCHEDULE: SyncSchedule = {
  hour: 6,
  minute: 0,
  timezone: "UTC",
  enabled: false,
};

function safeStats(value: Record<string, unknown>): StepStats {
  const result: StepStats = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "bigint") result[key] = item.toString();
    else if (typeof item === "string" || typeof item === "boolean")
      result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item))
      result[key] = item;
  }
  return result;
}

function safeErrorCode(error: unknown, stage: PipelineStepName): string {
  if (error instanceof PipelineStageError && error.terminal)
    return "PLAID_RELINK_REQUIRED";
  if (error instanceof Error && /timeout/i.test(error.message))
    return "UPSTREAM_TIMEOUT";
  return `${stage.toUpperCase().replaceAll("_", "_")}_FAILED`;
}

function toPortName(
  stage: PipelineStepName,
): keyof Required<PipelineStagePorts> {
  const names: Record<PipelineStepName, keyof Required<PipelineStagePorts>> = {
    plaid_sync: "plaidSync",
    liabilities_sync: "liabilitiesSync",
    bill_detect: "billDetect",
    bill_materialize: "billMaterialize",
    overdue_sweep: "overdueSweep",
    reconcile: "reconcile",
    balance_refresh: "balanceRefresh",
    net_worth_snapshot: "netWorthSnapshot",
    budget_check: "budgetCheck",
  };
  return names[stage];
}

export function createPipelineService(
  dependencies: Readonly<{
    repository?: PipelineRepository;
    db?: Pick<Db, "transaction">;
    enqueueJob?: JobEnqueuer;
    createRunId?: () => string;
    stagePorts?: PipelineStagePorts;
    cache?: Pick<ResponseCache, "invalidateUser">;
    withUserMutation?: UserMutationService["withUserMutation"];
    logger?: PipelineLogger;
  }> = {},
): PipelineService {
  const db = dependencies.db;
  let repository = dependencies.repository;
  const repositoryForCall = (): PipelineRepository => {
    repository ??= createPipelineRepository(getDb());
    return repository;
  };
  const enqueueJob: JobEnqueuer =
    dependencies.enqueueJob ?? ((input, tx) => defaultEnqueueJob(input, tx));
  const createId = dependencies.createRunId ?? randomUUID;
  const stagePorts = dependencies.stagePorts ?? {};
  const pipelineLogger = dependencies.logger ?? {
    error: (bindings: Record<string, unknown>, message: string) =>
      logger.error(bindings, message),
  };
  const cache = dependencies.cache ?? createResponseCache();
  const mutate =
    dependencies.withUserMutation ??
    ((userId: string, callback: (tx: DbTransaction) => Promise<unknown>) =>
      createWithUserMutation({ db: getDb(), cache })(userId, callback));

  async function startPipelineRunInTransaction(
    args: { userId: string; trigger: PipelineTrigger },
    tx: DbTransaction,
  ) {
    const repo = repositoryForCall();
    const runId = createId();
    const result = await enqueueJob(
      {
        type: SYNC_PIPELINE_JOB,
        payload: { userId: args.userId, runId },
        userId: args.userId,
      },
      tx,
    );
    if (result.deduped) return { runId: null, deduped: true };
    const run = await repo.createRun(
      { id: runId, userId: args.userId, trigger: args.trigger },
      tx,
    );
    await repo.setRunJob(run.id, result.job.id, tx);
    return { runId: run.id, deduped: false };
  }

  return {
    async startPipelineRun(args) {
      return (db ?? getDb()).transaction((tx) =>
        startPipelineRunInTransaction(args, tx),
      );
    },
    startPipelineRunInTransaction,
    async executePipelineJob(rawPayload, ctx) {
      const checkCancelled = (): void => ctx.signal.throwIfAborted();
      checkCancelled();
      const repo = repositoryForCall();
      const parsed = PipelineJobPayloadSchema.safeParse(rawPayload);
      if (!parsed.success)
        throw new ValidationError("Invalid pipeline job payload");
      const payload: PipelineJobPayload = parsed.data;
      const run = await repo.getRun(payload.userId, payload.runId);
      if (!run) throw new ValidationError("Invalid pipeline job target");
      if (run.jobId !== ctx.jobId)
        throw new ValidationError("Pipeline run does not belong to this job");
      checkCancelled();
      const existing = await repo.listSteps(payload.runId);
      const done = new Set(
        existing
          .filter((step) => step.status === "success")
          .map((step) => step.step),
      );
      if (
        existing.length > 0 &&
        !(await repo.reopenRunForJob(payload.runId, ctx.jobId, ctx.leaseToken))
      )
        throw new Error("Pipeline job lease no longer owns run");
      let syncFailed = false;
      let anyFailed = false;
      let retryError: unknown;
      for (const stage of PIPELINE_STEPS) {
        checkCancelled();
        if (done.has(stage)) continue;
        if (
          (stage === "bill_detect" || stage === "bill_materialize") &&
          syncFailed
        ) {
          const step = await repo.startStep({
            runId: payload.runId,
            userId: payload.userId,
            step: stage,
          });
          checkCancelled();
          await repo.finishStep(step.id, {
            status: "skipped",
            error: "PLAID_SYNC_FAILED",
          });
          continue;
        }
        const step = await repo.startStep({
          runId: payload.runId,
          userId: payload.userId,
          step: stage,
        });
        try {
          checkCancelled();
          const port = stagePorts[toPortName(stage)];
          if (!port)
            throw new ServiceUnavailableError(`${stage} stage unavailable`);
          const stats = safeStats(await port({ userId: payload.userId }));
          checkCancelled();
          await repo.finishStep(step.id, {
            status: "success",
            stats,
          });
        } catch (error: unknown) {
          checkCancelled();
          anyFailed = true;
          if (stage === "plaid_sync") {
            syncFailed = true;
            if (!(error instanceof PipelineStageError && !error.retryable))
              retryError = error;
          }
          await repo.finishStep(step.id, {
            status: "failed",
            error: safeErrorCode(error, stage),
          });
          await pipelineLogger.error(
            {
              runId: payload.runId,
              userId: payload.userId,
              stage,
              error: redactLogValue(error),
            },
            "Pipeline stage failed",
          );
        }
      }
      checkCancelled();
      const finished = await repo.finishRunForJob(
        payload.runId,
        ctx.jobId,
        ctx.leaseToken,
        syncFailed ? "failed" : anyFailed ? "partial" : "success",
      );
      if (!finished) throw new Error("Pipeline job lease no longer owns run");
      if (retryError) throw retryError;
    },
    async listRuns(userId, limit) {
      return (
        await repositoryForCall().listRuns(
          userId,
          Math.min(50, Math.max(1, limit)),
        )
      ).map(toPipelineRunDto);
    },
    async getRun(userId, runId) {
      const row = await repositoryForCall().getRun(userId, runId);
      return row ? toPipelineRunDto(row) : null;
    },
    async getSchedule(userId) {
      const row = await repositoryForCall().getSchedule(
        userId,
        DAILY_SYNC_SCHEDULE_KEY,
      );
      return row
        ? {
            hour: row.hour,
            minute: row.minute,
            timezone: row.timezone,
            enabled: row.enabled,
          }
        : DEFAULT_SCHEDULE;
    },
    async upsertSchedule(userId, input) {
      const parsed = UpdateSyncScheduleBodySchema.safeParse(input);
      if (!parsed.success) throw new ValidationError("Invalid schedule");
      try {
        new Intl.DateTimeFormat("en-US", {
          timeZone: parsed.data.timezone,
        }).format();
      } catch {
        throw new ValidationError(`Invalid timezone: ${parsed.data.timezone}`);
      }
      const saved = (await mutate(userId, (tx) =>
        repositoryForCall().upsertSchedule(
          { userId, scheduleKey: DAILY_SYNC_SCHEDULE_KEY, ...parsed.data },
          tx,
        ),
      )) as SyncScheduleRow;
      return {
        hour: saved.hour,
        minute: saved.minute,
        timezone: saved.timezone,
        enabled: saved.enabled,
      };
    },
  };
}

/** Runtime defaults used by the worker composition boundary. */
export function startPipelineRun(args: {
  userId: string;
  trigger: PipelineTrigger;
}): Promise<{ runId: string | null; deduped: boolean }> {
  return createPipelineService().startPipelineRun(args);
}

export function executePipelineJob(
  payload: Record<string, unknown>,
  ctx: { jobId: string; leaseToken: string; signal: AbortSignal },
): Promise<void> {
  return createPipelineService().executePipelineJob(payload, ctx);
}
