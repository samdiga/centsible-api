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
import { getDb } from "../platform/database/client.js";
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

/** Builds the complete local worker graph after environment validation. */
export function createDefaultWorkerAdapters(
  workerId: string,
): readonly WorkerAdapter[] {
  const db = getDb();
  const items = createPlaidItemsRepository(db);
  const sync = createPlaidSyncService({ db });
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
  const jobsRepository = createJobsRepository({ db });
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
    handler: createInboundEventHandler({ items }),
  });

  // Reverse shutdown order stops schedule production, then event/job claims.
  return [
    {
      enabled: true,
      start: () => jobPoller.start(),
      stop: () => jobPoller.stop(),
    },
    {
      enabled: true,
      start: () => eventPoller.start(),
      stop: () => eventPoller.stop(),
    },
    {
      enabled: true,
      start: () => scheduler.start(),
      stop: () => scheduler.stop(),
    },
  ];
}
