import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";

export type PipelineRunRow = typeof schema.pipelineRuns.$inferSelect;
export type PipelineRunStepRow = typeof schema.pipelineRunSteps.$inferSelect;
export type SyncScheduleRow = typeof schema.syncSchedules.$inferSelect;
export type PipelineTrigger = "scheduled" | "manual" | "webhook";
export type StepStats = Record<string, number | string | boolean>;
export type PipelineDb = Db | DbTransaction;

export type PipelineRepository = Readonly<{
  createRun: (
    args: { id?: string; userId: string; trigger: PipelineTrigger },
    db?: PipelineDb,
  ) => Promise<PipelineRunRow>;
  setRunJob: (runId: string, jobId: string, db?: PipelineDb) => Promise<void>;
  reopenRun: (runId: string, db?: PipelineDb) => Promise<void>;
  finishRun: (
    runId: string,
    status: "success" | "partial" | "failed",
    db?: PipelineDb,
  ) => Promise<void>;
  reopenRunForJob: (
    runId: string,
    jobId: string,
    leaseToken: string,
    db?: PipelineDb,
  ) => Promise<boolean>;
  finishRunForJob: (
    runId: string,
    jobId: string,
    leaseToken: string,
    status: "success" | "partial" | "failed",
    db?: PipelineDb,
  ) => Promise<boolean>;
  failRunForExpiredJob: (
    runId: string,
    jobId: string,
    db?: PipelineDb,
  ) => Promise<boolean>;
  hasActiveRun: (userId: string) => Promise<boolean>;
  listSteps: (runId: string, db?: PipelineDb) => Promise<PipelineRunStepRow[]>;
  startStep: (
    args: { runId: string; userId: string; step: string },
    db?: PipelineDb,
  ) => Promise<PipelineRunStepRow>;
  finishStep: (
    stepId: string,
    args: {
      status: "success" | "failed" | "skipped";
      stats?: StepStats;
      error?: string;
    },
    db?: PipelineDb,
  ) => Promise<void>;
  listRuns: (
    userId: string,
    limit: number,
  ) => Promise<Array<PipelineRunRow & { steps: PipelineRunStepRow[] }>>;
  getRun: (
    userId: string,
    runId: string,
  ) => Promise<(PipelineRunRow & { steps: PipelineRunStepRow[] }) | null>;
  getSchedule: (
    userId: string | null,
    scheduleKey: string,
  ) => Promise<SyncScheduleRow | null>;
  upsertSchedule: (
    args: {
      userId: string | null;
      scheduleKey: string;
      hour: number;
      minute: number;
      timezone: string;
      enabled: boolean;
    },
    db?: PipelineDb,
  ) => Promise<SyncScheduleRow>;
  listEnabledSchedules: () => Promise<SyncScheduleRow[]>;
  dispatchSchedule: (
    id: string,
    localDate: string,
    dispatch: (tx: DbTransaction) => Promise<void>,
  ) => Promise<boolean>;
  purgeRunsOlderThanDays: (days: number) => Promise<number>;
  deleteRun: (runId: string, db?: PipelineDb) => Promise<void>;
}>;

async function withSteps<T extends { id: string }>(
  runs: T[],
  db: PipelineDb,
): Promise<Array<T & { steps: PipelineRunStepRow[] }>> {
  if (runs.length === 0) return [];
  const steps = await db
    .select()
    .from(schema.pipelineRunSteps)
    .where(
      inArray(
        schema.pipelineRunSteps.runId,
        runs.map((run) => run.id),
      ),
    )
    .orderBy(
      asc(schema.pipelineRunSteps.createdAt),
      asc(schema.pipelineRunSteps.id),
    );
  const grouped = new Map<string, PipelineRunStepRow[]>();
  for (const step of steps)
    grouped.set(step.runId, [...(grouped.get(step.runId) ?? []), step]);
  return runs.map((run) => ({ ...run, steps: grouped.get(run.id) ?? [] }));
}

export function createPipelineRepository(db: Db = getDb()): PipelineRepository {
  return {
    async createRun(args, tx = db) {
      const rows = await tx
        .insert(schema.pipelineRuns)
        .values({
          ...(args.id ? { id: args.id } : {}),
          userId: args.userId,
          trigger: args.trigger,
          status: "running",
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Pipeline run insert returned no row");
      return row;
    },
    async setRunJob(runId, jobId, tx = db) {
      await tx
        .update(schema.pipelineRuns)
        .set({ jobId })
        .where(eq(schema.pipelineRuns.id, runId));
    },
    async reopenRun(runId, database = db) {
      await database
        .update(schema.pipelineRuns)
        .set({ status: "running", finishedAt: null })
        .where(eq(schema.pipelineRuns.id, runId));
    },
    async finishRun(runId, status, database = db) {
      await database
        .update(schema.pipelineRuns)
        .set({ status, finishedAt: new Date() })
        .where(eq(schema.pipelineRuns.id, runId));
    },
    async reopenRunForJob(runId, jobId, leaseToken, database = db) {
      const rows = await database.execute<{ id: string }>(sql`
        UPDATE pipeline_runs AS run
        SET status = 'running', finished_at = NULL
        FROM jobs AS job
        WHERE run.id = ${runId}
          AND run.job_id = ${jobId}
          AND job.id = ${jobId}
          AND job.status = 'running'
          AND job.lease_token = ${leaseToken}
        RETURNING run.id
      `);
      return rows.length > 0;
    },
    async finishRunForJob(runId, jobId, leaseToken, status, database = db) {
      const rows = await database.execute<{ id: string }>(sql`
        UPDATE pipeline_runs AS run
        SET status = ${status}, finished_at = now()
        FROM jobs AS job
        WHERE run.id = ${runId}
          AND run.job_id = ${jobId}
          AND job.id = ${jobId}
          AND job.status = 'running'
          AND job.lease_token = ${leaseToken}
        RETURNING run.id
      `);
      return rows.length > 0;
    },
    async failRunForExpiredJob(runId, jobId, database = db) {
      const rows = await database
        .update(schema.pipelineRuns)
        .set({ status: "failed", finishedAt: new Date() })
        .where(
          and(
            eq(schema.pipelineRuns.id, runId),
            eq(schema.pipelineRuns.jobId, jobId),
            eq(schema.pipelineRuns.status, "running"),
          ),
        )
        .returning({ id: schema.pipelineRuns.id });
      return rows.length > 0;
    },
    async hasActiveRun(userId) {
      const rows = await db
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.userId, userId),
            eq(schema.pipelineRuns.status, "running"),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async listSteps(runId, database = db) {
      return database
        .select()
        .from(schema.pipelineRunSteps)
        .where(eq(schema.pipelineRunSteps.runId, runId))
        .orderBy(
          asc(schema.pipelineRunSteps.createdAt),
          asc(schema.pipelineRunSteps.id),
        );
    },
    async startStep(args, tx = db) {
      const rows = await tx
        .insert(schema.pipelineRunSteps)
        .values({
          runId: args.runId,
          userId: args.userId,
          step: args.step,
          status: "running",
          startedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.pipelineRunSteps.runId, schema.pipelineRunSteps.step],
          set: {
            status: "running",
            startedAt: new Date(),
            finishedAt: null,
            error: null,
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Pipeline step insert returned no row");
      return row;
    },
    async finishStep(stepId, args, tx = db) {
      await tx
        .update(schema.pipelineRunSteps)
        .set({
          status: args.status,
          stats: args.stats ?? null,
          error: args.error ?? null,
          finishedAt: new Date(),
        })
        .where(eq(schema.pipelineRunSteps.id, stepId));
    },
    async listRuns(userId, limit) {
      const runs = await db
        .select()
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.userId, userId))
        .orderBy(
          desc(schema.pipelineRuns.startedAt),
          desc(schema.pipelineRuns.id),
        )
        .limit(Math.min(50, Math.max(1, limit)));
      return withSteps(runs, db);
    },
    async getRun(userId, runId) {
      const rows = await db
        .select()
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.id, runId),
            eq(schema.pipelineRuns.userId, userId),
          ),
        )
        .limit(1);
      return (await withSteps(rows, db))[0] ?? null;
    },
    async getSchedule(userId, scheduleKey) {
      const rows = await db
        .select()
        .from(schema.syncSchedules)
        .where(
          and(
            userId === null
              ? sql`${schema.syncSchedules.userId} IS NULL`
              : eq(schema.syncSchedules.userId, userId),
            eq(schema.syncSchedules.scheduleKey, scheduleKey),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async upsertSchedule(args, tx = db) {
      const rows = await tx
        .insert(schema.syncSchedules)
        .values(args)
        .onConflictDoUpdate({
          target: [
            schema.syncSchedules.userId,
            schema.syncSchedules.scheduleKey,
          ],
          set: {
            hour: args.hour,
            minute: args.minute,
            timezone: args.timezone,
            enabled: args.enabled,
            updatedAt: new Date(),
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Schedule upsert returned no row");
      return row;
    },
    async listEnabledSchedules() {
      return db
        .select()
        .from(schema.syncSchedules)
        .where(eq(schema.syncSchedules.enabled, true));
    },
    async dispatchSchedule(id, localDate, dispatch) {
      return db.transaction(async (tx) => {
        const rows = await tx.execute<{
          id: string;
          last_dispatched_for: string | null;
        }>(
          sql`SELECT id, last_dispatched_for FROM sync_schedules WHERE id = ${id} FOR UPDATE`,
        );
        const row = rows[0];
        if (
          !row ||
          (row.last_dispatched_for !== null &&
            row.last_dispatched_for >= localDate)
        )
          return false;
        await dispatch(tx);
        const updated = await tx.execute<{ id: string }>(
          sql`UPDATE sync_schedules SET last_dispatched_for = ${localDate}, updated_at = now() WHERE id = ${id} AND (last_dispatched_for IS NULL OR last_dispatched_for < ${localDate}) RETURNING id`,
        );
        return updated.length > 0;
      });
    },
    async purgeRunsOlderThanDays(days) {
      const rows = await db.execute<{ id: string }>(
        sql`DELETE FROM pipeline_runs WHERE started_at < now() - (${days} || ' days')::interval RETURNING id`,
      );
      return rows.length;
    },
    async deleteRun(runId, database = db) {
      await database
        .delete(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.id, runId));
    },
  };
}

/** Lazy process-wide repository for callers that use the established object API. */
export const pipelineRepository: PipelineRepository = new Proxy(
  {} as PipelineRepository,
  {
    get(_target, property: keyof PipelineRepository) {
      return (...args: unknown[]) => {
        const repository = createPipelineRepository();
        const method = Reflect.get(repository, property) as (
          ...values: unknown[]
        ) => unknown;
        return method(...args);
      };
    },
  },
);
