import {
  createBillWorkerLifecycle,
  type BillWorkerLifecycle,
} from "../modules/bills/index.js";
import {
  budgetsRepository,
  createBudgetsService,
} from "../modules/budgets/index.js";
import { createNetWorthSnapshotService } from "../modules/dashboard/index.js";
import { createForecastRepository } from "../modules/forecast/index.js";
import {
  createSyncHealthAlertsService,
  notificationPreferencesRepository,
} from "../modules/notifications/index.js";
import {
  createPipelineRepository,
  createPipelineService,
} from "../modules/pipeline/index.js";
import {
  createPlaidItemsRepository,
  createPlaidLiabilitiesService,
  createPlaidService,
  createPlaidSyncService,
} from "../modules/plaid/index.js";
import { createInboundEventHandler } from "../modules/plaid/inbound-event-handler.js";
import { createInboundEventsPoller } from "../modules/plaid/inbound-events-poller.js";
import { createInboundEventsRepository } from "../modules/plaid/inbound-events.repository.js";
import { createPlaidRawImportsRepository } from "../modules/plaid/plaid-raw-imports.repository.js";
import { applyRuleRetroactively } from "../modules/rules/index.js";
import { createApnsSender } from "../platform/apns/index.js";
import { env } from "../platform/config/env.js";
import { getDb } from "../platform/database/client.js";
import { logger } from "../platform/logging/logger.js";
import { NotFoundError } from "../platform/errors/app-error.js";
import { createJobsPoller } from "../platform/jobs/jobs-poller.js";
import {
  createJobsRepository,
  enqueueJob,
} from "../platform/jobs/jobs.repository.js";
import { createRetentionRepository } from "../platform/jobs/retention.repository.js";
import {
  createScheduler,
  SYSTEM_SCHEDULES,
} from "../platform/jobs/scheduler.js";
import type { WorkerAdapter } from "./create-worker.js";
import {
  createJobHandlers,
  createPipelineStagePorts,
  type PipelineWorkerServices,
} from "./worker-services.js";

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createWorkerSweepAdapters(
  sources: Readonly<{
    scheduler: Readonly<{
      tickOnce: () => Promise<void>;
      stop: () => Promise<void>;
    }>;
    inbound: Readonly<{
      drainOnce: () => Promise<void>;
      nextWakeAt: () => Promise<Date | null>;
      stop: () => Promise<void>;
    }>;
    jobs: Readonly<{
      drainOnce: () => Promise<void>;
      nextWakeAt: () => Promise<Date | null>;
      stop: () => Promise<void>;
    }>;
  }>,
): readonly WorkerAdapter[] {
  return [
    {
      enabled: true,
      sweep: () => sources.scheduler.tickOnce(),
      stop: () => sources.scheduler.stop(),
    },
    {
      enabled: true,
      sweep: () => sources.inbound.drainOnce(),
      nextWakeAt: () => sources.inbound.nextWakeAt(),
      stop: () => sources.inbound.stop(),
    },
    {
      enabled: true,
      sweep: () => sources.jobs.drainOnce(),
      nextWakeAt: () => sources.jobs.nextWakeAt(),
      stop: () => sources.jobs.stop(),
    },
  ];
}

/** Builds the complete local worker graph after environment validation. */
export function createDefaultWorkerAdapters(
  workerId: string,
): readonly WorkerAdapter[] {
  const db = getDb();
  const items = createPlaidItemsRepository(db);
  const enqueueSyncHealth = async (userId: string, scheduledFor?: Date) => {
    await enqueueJob({
      type: "sync_health_alerts",
      payload: { userId },
      userId,
      ...(scheduledFor ? { scheduledFor } : {}),
    });
  };
  const syncHealth = createSyncHealthAlertsService({
    preferences: notificationPreferencesRepository,
    sender: createApnsSender({ env: env() }),
    deferRun: (userId, at) => enqueueSyncHealth(userId, at),
  });
  const onItemStatusChanged = (userId: string) =>
    enqueueSyncHealth(userId).catch((error: unknown) => {
      logger.warn({ userId, error }, "could not enqueue sync-health alerts");
    });
  const sync = createPlaidSyncService({ db, onItemStatusChanged });
  const liabilities = createPlaidLiabilitiesService();
  const plaid = createPlaidService({ db, consume: () => undefined });
  const bills: BillWorkerLifecycle = createBillWorkerLifecycle();
  const snapshot = createNetWorthSnapshotService();
  const budgets = createBudgetsService();
  const forecast = createForecastRepository(db);
  const rawImports = createPlaidRawImportsRepository(db);
  const retention = createRetentionRepository({ db });
  const pipelineRepository = createPipelineRepository(db);

  const pipelineServices: PipelineWorkerServices = {
    listItemIds: async (userId) =>
      (await items.listByUser(userId)).map((item) => item.id),
    syncItem: (userId, itemId) => sync.syncItem(userId, itemId),
    syncLiabilities: (userId, itemId) =>
      liabilities.syncItemLiabilities(userId, itemId),
    refreshItem: (userId, itemId) => plaid.refreshItemBalances(userId, itemId),
    detectBills: (userId) => bills.detect(userId),
    upsertStatementBills: (userId) => bills.upsertStatementBills(userId),
    materializeBills: (userId) => bills.materialize(userId),
    sweepOverdue: (userId) => bills.sweepOverdue(userId),
    reconcile: (userId) => bills.resolveMaturedForecastEvents(userId),
    snapshotNetWorth: (userId) => snapshot.snapshot(userId),
    async budgetCheck(userId) {
      const active = await budgetsRepository.getActiveBudget(userId);
      if (!active) return { hasActiveBudget: false };
      try {
        const progress = await budgets.getBudgetProgress(userId, active.id);
        return {
          hasActiveBudget: true,
          categoriesTracked: progress.items.length,
          categoriesOver: progress.items.filter(
            (item) => BigInt(item.remainingCents) < 0n,
          ).length,
        };
      } catch (error) {
        if (error instanceof NotFoundError)
          return {
            hasActiveBudget: true,
            categoriesTracked: 0,
            categoriesOver: 0,
          };
        throw error;
      }
    },
  };
  const pipeline = createPipelineService({
    db,
    repository: pipelineRepository,
    stagePorts: createPipelineStagePorts(pipelineServices),
  });
  const jobsRepository = createJobsRepository({
    db,
    async onTerminalExpiredJob(job, tx) {
      if (
        job.type !== "sync_pipeline" ||
        typeof job.payload !== "object" ||
        job.payload === null ||
        Array.isArray(job.payload)
      )
        return;
      const runId = (job.payload as Record<string, unknown>).runId;
      if (typeof runId !== "string" || !canonicalUuid.test(runId)) return;
      await pipelineRepository.failRunForExpiredJob(runId, job.id, tx);
    },
  });
  const handlers = createJobHandlers({
    syncItem: (userId, itemId) => sync.syncItem(userId, itemId),
    refreshItem: (userId, itemId) => plaid.refreshItemBalances(userId, itemId),
    purgeRawImports: () => rawImports.purgeOlderThanDays(30),
    purgeRetention: () => retention.deleteExpiredOperationalData(),
    applyRule: (ruleId, userId) => applyRuleRetroactively(ruleId, userId),
    detectBills: (userId) => bills.detect(userId),
    materializeBills: (userId, billId) => bills.materialize(userId, billId),
    sweepOverdue: (userId) => bills.sweepOverdue(userId),
    computeForecastAccuracy: () => forecast.computeAndSaveAccuracyBatch(),
    runSyncHealthAlerts: (userId) => syncHealth.runForUser(userId),
    runSyncHealthAlertsSweep: () => syncHealth.runForAllUsers(),
    executePipeline: (payload, context) =>
      pipeline.executePipelineJob(payload, context),
  });
  const jobPoller = createJobsPoller({
    workerId,
    handlers,
    repository: jobsRepository,
  });
  const scheduler = createScheduler({
    schedules: pipelineRepository,
    pipelineService: pipeline,
    enqueue: (input, tx) => enqueueJob(input, tx),
    reapExpiredJobs: async () => {
      await jobsRepository.reapExpiredJobs();
    },
    ensureSystemSchedules: async () => {
      for (const schedule of SYSTEM_SCHEDULES)
        await pipelineRepository.upsertSchedule({
          userId: null,
          scheduleKey: schedule.scheduleKey,
          hour: schedule.hour,
          minute: schedule.minute,
          timezone: "UTC",
          enabled: true,
        });
    },
  });
  const inboundRepository = createInboundEventsRepository(db);
  const eventPoller = createInboundEventsPoller({
    workerId,
    repository: inboundRepository,
    handler: createInboundEventHandler({ items, onItemStatusChanged }),
  });

  return createWorkerSweepAdapters({
    scheduler,
    inbound: eventPoller,
    jobs: jobPoller,
  });
}
