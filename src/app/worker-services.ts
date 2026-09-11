import { ValidationError } from "../platform/errors/app-error.js";
import type {
  JobHandler,
  JobHandlerContext,
} from "../platform/jobs/jobs-poller.js";
import {
  PipelineStageError,
  type PipelineStagePorts,
} from "../modules/pipeline/index.js";
import { PlaidServiceError } from "../modules/plaid/plaid.errors.js";

export type WorkerServices = Readonly<{
  syncItem: (userId: string, itemId: string) => Promise<unknown>;
  refreshItem: (userId: string, itemId: string) => Promise<unknown>;
  purgeRawImports: () => Promise<unknown>;
  purgeRetention: () => Promise<unknown>;
  applyRule: (ruleId: string, userId: string) => Promise<unknown>;
  detectBills: (userId: string) => Promise<unknown>;
  materializeBills: (userId: string, billId?: string) => Promise<unknown>;
  sweepOverdue: (userId: string) => Promise<unknown>;
  computeForecastAccuracy: () => Promise<unknown>;
  executePipeline: (
    payload: Record<string, unknown>,
    context: Pick<JobHandlerContext, "jobId" | "leaseToken" | "signal">,
  ) => Promise<unknown>;
}>;

export type PipelineWorkerServices = Readonly<{
  listItemIds: (userId: string) => Promise<string[]>;
  syncItem: (
    userId: string,
    itemId: string,
  ) => Promise<{ added: number; modified: number; removed: number }>;
  syncLiabilities: (
    userId: string,
    itemId: string,
  ) => Promise<{ accountsUpdated: number; unavailableReason: string | null }>;
  refreshItem: (userId: string, itemId: string) => Promise<unknown[]>;
  detectBills: (
    userId: string,
  ) => Promise<{ created: number; updated: number }>;
  upsertStatementBills: (
    userId: string,
  ) => Promise<{ created: number; updated: number }>;
  materializeBills: (
    userId: string,
  ) => Promise<{ setupsMaterialized: number; occurrencesCreated: number }>;
  sweepOverdue: (userId: string) => Promise<unknown>;
  reconcile: (userId: string) => Promise<unknown>;
  snapshotNetWorth: (
    userId: string,
  ) => Promise<{ date: string; netWorthCents: string }>;
  budgetCheck: (userId: string) => Promise<Record<string, unknown>>;
}>;

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim())
    throw new ValidationError(`Invalid worker payload: ${key} is required`);
  return value;
}

/** Maps persisted job types to narrow domain services without exposing repositories. */
export function createJobHandlers(
  services: WorkerServices,
): Readonly<Record<string, JobHandler>> {
  return {
    plaid_sync: async (payload) => {
      await services.syncItem(
        requiredString(payload, "userId"),
        requiredString(payload, "itemId"),
      );
    },
    plaid_balance_refresh: async (payload) => {
      await services.refreshItem(
        requiredString(payload, "userId"),
        requiredString(payload, "itemId"),
      );
    },
    plaid_raw_imports_purge: async () => {
      await services.purgeRawImports();
    },
    retention_purge: async () => {
      await services.purgeRetention();
    },
    rule_retroactive_apply: async (payload) => {
      await services.applyRule(
        requiredString(payload, "ruleId"),
        requiredString(payload, "userId"),
      );
    },
    recurring_detect: async (payload) => {
      await services.detectBills(requiredString(payload, "userId"));
    },
    materialize_recurring: async (payload) => {
      const seriesId = payload.seriesId;
      if (seriesId !== undefined && typeof seriesId !== "string")
        throw new ValidationError(
          "Invalid worker payload: seriesId must be a string",
        );
      await services.materializeBills(
        requiredString(payload, "userId"),
        seriesId,
      );
    },
    bill_overdue_sweep: async (payload) => {
      await services.sweepOverdue(requiredString(payload, "userId"));
    },
    compute_forecast_accuracy: async () => {
      await services.computeForecastAccuracy();
    },
    sync_pipeline: async (payload, context) => {
      await services.executePipeline(payload, {
        jobId: context.jobId,
        leaseToken: context.leaseToken,
        signal: context.signal,
      });
    },
  };
}

/** Creates the nine fixed pipeline stages from reusable domain-level ports. */
export function createPipelineStagePorts(
  services: PipelineWorkerServices,
): PipelineStagePorts {
  return {
    async plaidSync({ userId }) {
      const itemIds = await services.listItemIds(userId);
      const stats = {
        itemsSynced: 0,
        itemsNeedAttention: 0,
        transactionsAdded: 0,
        transactionsModified: 0,
        transactionsRemoved: 0,
      };
      let transientFailure: unknown;
      for (const itemId of itemIds) {
        try {
          const result = await services.syncItem(userId, itemId);
          stats.itemsSynced += 1;
          stats.transactionsAdded += result.added;
          stats.transactionsModified += result.modified;
          stats.transactionsRemoved += result.removed;
        } catch (error) {
          if (error instanceof PlaidServiceError && error.isTerminal) {
            stats.itemsNeedAttention += 1;
          } else {
            transientFailure ??= error;
          }
        }
      }
      if (transientFailure)
        throw new PipelineStageError("Plaid sync failed", true);
      if (stats.itemsNeedAttention > 0 && stats.itemsSynced === 0)
        throw new PipelineStageError(
          "Connections need to be re-linked",
          false,
          true,
        );
      return stats;
    },
    async liabilitiesSync({ userId }) {
      let accountsUpdated = 0;
      let itemsUnavailable = 0;
      let firstUnavailableReason: string | undefined;
      for (const itemId of await services.listItemIds(userId)) {
        const result = await services.syncLiabilities(userId, itemId);
        accountsUpdated += result.accountsUpdated;
        if (result.unavailableReason) {
          itemsUnavailable += 1;
          firstUnavailableReason ??= result.unavailableReason;
        }
      }
      return {
        accountsUpdated,
        itemsUnavailable,
        ...(firstUnavailableReason ? { firstUnavailableReason } : {}),
      };
    },
    async billDetect({ userId }) {
      const result = await services.detectBills(userId);
      return { billsCreated: result.created, billsUpdated: result.updated };
    },
    async billMaterialize({ userId }) {
      const statements = await services.upsertStatementBills(userId);
      const materialized = await services.materializeBills(userId);
      return {
        statementBillsCreated: statements.created,
        statementBillsUpdated: statements.updated,
        setupsMaterialized: materialized.setupsMaterialized,
        occurrencesCreated: materialized.occurrencesCreated,
      };
    },
    async overdueSweep({ userId }) {
      await services.sweepOverdue(userId);
      return { completed: true };
    },
    async reconcile({ userId }) {
      await services.reconcile(userId);
      return { completed: true };
    },
    async balanceRefresh({ userId }) {
      let accountsRefreshed = 0;
      for (const itemId of await services.listItemIds(userId))
        accountsRefreshed += (await services.refreshItem(userId, itemId))
          .length;
      return { accountsRefreshed };
    },
    async netWorthSnapshot({ userId }) {
      const result = await services.snapshotNetWorth(userId);
      return { date: result.date, netWorthCents: result.netWorthCents };
    },
    async budgetCheck({ userId }) {
      return services.budgetCheck(userId);
    },
  };
}
