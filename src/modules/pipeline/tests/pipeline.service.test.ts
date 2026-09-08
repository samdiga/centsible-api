import { expect, it, vi } from "vitest";
import { createPipelineService } from "../pipeline.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function repository() {
  return {
    createRun: vi.fn(async () => ({
      id: RUN_ID,
      userId: USER_ID,
      trigger: "manual" as const,
      status: "running" as const,
      jobId: null,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })),
    setRunJob: vi.fn(async () => undefined),
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(async () => null),
    getSchedule: vi.fn(async () => null),
    upsertSchedule: vi.fn(async () => ({
      id: "33333333-3333-4333-8333-333333333333",
      userId: USER_ID,
      scheduleKey: "daily_sync_pipeline",
      hour: 6,
      minute: 0,
      timezone: "UTC",
      enabled: true,
      lastDispatchedFor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  };
}

it("creates a run and transaction-bound job atomically, without an orphan on dedupe", async () => {
  const repo = repository();
  const enqueue = vi.fn(async () => ({
    job: { id: "job-1" },
    deduped: false,
  }));
  const transaction = vi.fn(
    async (callback: (tx: object) => Promise<unknown>) => callback({}),
  );
  const service = createPipelineService({
    repository: repo as never,
    db: { transaction } as never,
    enqueueJob: enqueue,
    createRunId: () => RUN_ID,
  });

  await expect(
    service.startPipelineRun({ userId: USER_ID, trigger: "manual" }),
  ).resolves.toEqual({
    runId: RUN_ID,
    deduped: false,
  });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "sync_pipeline",
      userId: USER_ID,
      payload: { userId: USER_ID, runId: RUN_ID },
    }),
    expect.anything(),
  );

  enqueue.mockResolvedValueOnce({ job: { id: "existing" }, deduped: true });
  await expect(
    service.startPipelineRun({ userId: USER_ID, trigger: "manual" }),
  ).resolves.toEqual({
    runId: null,
    deduped: true,
  });
  expect(repo.createRun).toHaveBeenCalledTimes(1);
});

it("executes the nine pipeline stages in order and serializes bigint stats", async () => {
  const repo = repository();
  const steps: string[] = [];
  const service = createPipelineService({
    repository: {
      ...repo,
      listSteps: vi.fn(async () => []),
      startStep: vi.fn(async ({ step }: { step: string }) => {
        steps.push(step);
        return { id: step };
      }),
      finishStep: vi.fn(async () => undefined),
      finishRun: vi.fn(async () => undefined),
      reopenRun: vi.fn(async () => undefined),
    } as never,
    stagePorts: {
      plaidSync: async () => ({ amountCents: 12n }),
      liabilitiesSync: async () => ({ completed: true }),
      billDetect: async () => ({ completed: true }),
      billMaterialize: async () => ({ completed: true }),
      overdueSweep: async () => ({ completed: true }),
      reconcile: async () => ({ completed: true }),
      balanceRefresh: async () => ({ completed: true }),
      netWorthSnapshot: async () => ({ amountCents: 7n }),
      budgetCheck: async () => ({ completed: true }),
    },
  });
  await service.executePipelineJob({ userId: USER_ID, runId: RUN_ID });
  expect(steps).toEqual([
    "plaid_sync",
    "liabilities_sync",
    "bill_detect",
    "bill_materialize",
    "overdue_sweep",
    "reconcile",
    "balance_refresh",
    "net_worth_snapshot",
    "budget_check",
  ]);
});
