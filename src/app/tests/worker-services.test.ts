import { expect, it, vi } from "vitest";
import {
  createJobHandlers,
  createPipelineStagePorts,
} from "../worker-services.js";

it("maps durable job names to typed worker services", async () => {
  const syncItem = vi.fn(async () => undefined);
  const materialize = vi.fn(async () => undefined);
  const pipeline = vi.fn(async () => undefined);
  const handlers = createJobHandlers({
    syncItem,
    refreshItem: vi.fn(async () => undefined),
    purgeRawImports: vi.fn(async () => undefined),
    purgeRetention: vi.fn(async () => undefined),
    applyRule: vi.fn(async () => undefined),
    detectBills: vi.fn(async () => undefined),
    materializeBills: materialize,
    sweepOverdue: vi.fn(async () => undefined),
    computeForecastAccuracy: vi.fn(async () => undefined),
    executePipeline: pipeline,
  });

  await handlers.plaid_sync?.({ userId: "user", itemId: "item" }, {} as never);
  await handlers.materialize_recurring?.(
    { userId: "user", seriesId: "bill" },
    {} as never,
  );
  const signal = new AbortController().signal;
  await handlers.sync_pipeline?.({ userId: "user", runId: "run" }, {
    jobId: "job",
    leaseToken: "lease-token",
    signal,
  } as never);

  expect(syncItem).toHaveBeenCalledWith("user", "item");
  expect(materialize).toHaveBeenCalledWith("user", "bill");
  expect(pipeline).toHaveBeenCalledWith(
    { userId: "user", runId: "run" },
    { jobId: "job", leaseToken: "lease-token", signal },
  );
  expect(Object.keys(handlers).sort()).toEqual([
    "bill_overdue_sweep",
    "compute_forecast_accuracy",
    "materialize_recurring",
    "plaid_balance_refresh",
    "plaid_raw_imports_purge",
    "plaid_sync",
    "recurring_detect",
    "retention_purge",
    "rule_retroactive_apply",
    "sync_pipeline",
  ]);
});

it("aggregates per-item Plaid sync stats for the pipeline", async () => {
  const ports = createPipelineStagePorts({
    listItemIds: vi.fn(async () => ["item-1", "item-2"]),
    syncItem: vi
      .fn()
      .mockResolvedValueOnce({ added: 2, modified: 1, removed: 0 })
      .mockResolvedValueOnce({ added: 0, modified: 0, removed: 3 }),
    syncLiabilities: vi.fn(async () => ({
      accountsUpdated: 0,
      unavailableReason: null,
    })),
    refreshItem: vi.fn(async () => []),
    detectBills: vi.fn(async () => ({ created: 0, updated: 0 })),
    upsertStatementBills: vi.fn(async () => ({ created: 0, updated: 0 })),
    materializeBills: vi.fn(async () => ({
      setupsMaterialized: 0,
      occurrencesCreated: 0,
    })),
    sweepOverdue: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    snapshotNetWorth: vi.fn(async () => ({
      date: "2026-09-09",
      netWorthCents: "1",
    })),
    budgetCheck: vi.fn(async () => ({ hasActiveBudget: false })),
  });

  await expect(ports.plaidSync?.({ userId: "user" })).resolves.toEqual({
    itemsSynced: 2,
    itemsNeedAttention: 0,
    transactionsAdded: 2,
    transactionsModified: 1,
    transactionsRemoved: 3,
  });
});
