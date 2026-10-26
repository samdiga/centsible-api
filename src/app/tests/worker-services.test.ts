import { expect, it, vi } from "vitest";
import {
  createJobHandlers,
  createPipelineStagePorts,
} from "../worker-services.js";

it("maps durable job names to typed worker services", async () => {
  const syncItem = vi.fn(async () => undefined);
  const materialize = vi.fn(async () => undefined);
  const pipeline = vi.fn(async () => undefined);
  const syncHealth = vi.fn(async () => undefined);
  const syncHealthSweep = vi.fn(async () => undefined);
  const billReminders = vi.fn(async () => undefined);
  const billRemindersSchedule = vi.fn(async () => undefined);
  const handlers = createJobHandlers({
    syncItem,
    refreshCachedAccountsForItem: vi.fn(async () => 0),
    purgeRawImports: vi.fn(async () => undefined),
    purgeRetention: vi.fn(async () => undefined),
    applyRule: vi.fn(async () => undefined),
    detectBills: vi.fn(async () => undefined),
    materializeBills: materialize,
    sweepOverdue: vi.fn(async () => undefined),
    computeForecastAccuracy: vi.fn(async () => undefined),
    runSyncHealthAlerts: syncHealth,
    runSyncHealthAlertsSweep: syncHealthSweep,
    runBillReminders: billReminders,
    scheduleBillReminders: billRemindersSchedule,
    executePipeline: pipeline,
  });
  await handlers.sync_health_alerts?.({ userId: "user" }, {} as never);
  await handlers.sync_health_alerts_sweep?.({ kind: "daily" }, {} as never);
  expect(syncHealth).toHaveBeenCalledWith("user");
  expect(syncHealthSweep).toHaveBeenCalledTimes(1);
  await handlers.bill_reminders?.(
    { userId: "user", localDate: "2026-10-01" },
    {} as never,
  );
  await handlers.bill_reminders_schedule?.({ kind: "daily" }, {} as never);
  expect(billReminders).toHaveBeenCalledWith("user", "2026-10-01");
  expect(billRemindersSchedule).toHaveBeenCalledTimes(1);
  await expect(
    handlers.bill_reminders?.({ userId: "user" }, {} as never),
  ).rejects.toThrow("localDate is required");
  await expect(handlers.sync_health_alerts?.({}, {} as never)).rejects.toThrow(
    "userId is required",
  );

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
    "bill_reminders",
    "bill_reminders_schedule",
    "compute_forecast_accuracy",
    "materialize_recurring",
    "plaid_balance_refresh",
    "plaid_raw_imports_purge",
    "plaid_sync",
    "recurring_detect",
    "retention_purge",
    "rule_retroactive_apply",
    "sync_health_alerts",
    "sync_health_alerts_sweep",
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
    refreshCachedAccountsForItem: vi.fn(async () => 0),
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

it("counts Liabilities results per connection without failing on a refusal", async () => {
  const ports = createPipelineStagePorts({
    listItemIds: vi.fn(async () => ["card", "checking", "login", "consent"]),
    syncLiabilities: vi
      .fn()
      .mockResolvedValueOnce({ accountsUpdated: 2, unavailableReason: null })
      .mockResolvedValueOnce({
        accountsUpdated: 0,
        unavailableReason: null,
        skipped: true,
      })
      .mockResolvedValueOnce({
        accountsUpdated: 0,
        unavailableReason: "ITEM_LOGIN_REQUIRED",
      })
      .mockResolvedValueOnce({
        accountsUpdated: 0,
        unavailableReason: "ADDITIONAL_CONSENT_REQUIRED",
      }),
  } as never);

  await expect(ports.liabilitiesSync?.({ userId: "user" })).resolves.toEqual({
    accountsUpdated: 2,
    itemsUnavailable: 2,
    itemsSkipped: 1,
    unavailable_ITEM_LOGIN_REQUIRED: 1,
    unavailable_ADDITIONAL_CONSENT_REQUIRED: 1,
    firstUnavailableReason: "ITEM_LOGIN_REQUIRED",
  });
});

it("counts accounts refreshed from the cached account endpoint", async () => {
  const refreshCachedAccountsForItem = vi
    .fn()
    .mockResolvedValueOnce(2)
    .mockResolvedValueOnce(1);
  const ports = createPipelineStagePorts({
    listItemIds: vi.fn(async () => ["item-1", "item-2"]),
    refreshCachedAccountsForItem,
  } as never);

  await expect(
    ports.cachedAccountRefresh?.({ userId: "user" }),
  ).resolves.toEqual({
    accountsRefreshed: 3,
  });
  expect(refreshCachedAccountsForItem).toHaveBeenNthCalledWith(
    1,
    "user",
    "item-1",
  );
  expect(refreshCachedAccountsForItem).toHaveBeenNthCalledWith(
    2,
    "user",
    "item-2",
  );
});
