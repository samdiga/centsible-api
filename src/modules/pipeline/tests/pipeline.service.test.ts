import { expect, it, vi } from "vitest";
import { createPipelineService } from "../pipeline.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "lease-token";

function jobContext(signal = new AbortController().signal) {
  return { jobId: "job-1", leaseToken: LEASE_TOKEN, signal };
}

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

it("wakes the worker only after a new manual run commits", async () => {
  const repo = repository();
  const wakeWorker = vi.fn(async () => undefined);
  const enqueue = vi
    .fn()
    .mockResolvedValueOnce({ job: { id: "job-1" }, deduped: false })
    .mockResolvedValueOnce({ job: { id: "job-2" }, deduped: false })
    .mockResolvedValueOnce({ job: { id: "existing" }, deduped: true });
  const service = createPipelineService({
    repository: repo as never,
    db: {
      transaction: async (callback: (tx: object) => Promise<unknown>) =>
        callback({}),
    } as never,
    enqueueJob: enqueue,
    createRunId: () => RUN_ID,
    wakeWorker,
  });

  await service.startPipelineRun({ userId: USER_ID, trigger: "manual" });
  await service.startPipelineRun({ userId: USER_ID, trigger: "scheduled" });
  await service.startPipelineRun({ userId: USER_ID, trigger: "manual" });

  expect(wakeWorker).toHaveBeenCalledOnce();
});

it("keeps a committed manual run queued when the wake transport fails", async () => {
  const wakeFailure = new Error("loopback unavailable secret");
  const warn = vi.fn();
  const service = createPipelineService({
    repository: repository() as never,
    db: {
      transaction: async (callback: (tx: object) => Promise<unknown>) =>
        callback({}),
    } as never,
    enqueueJob: vi.fn(async () => ({
      job: { id: "job-1" },
      deduped: false,
    })),
    createRunId: () => RUN_ID,
    wakeWorker: vi.fn(async () => Promise.reject(wakeFailure)),
    logger: { error: vi.fn(), warn },
  });

  await expect(
    service.startPipelineRun({ userId: USER_ID, trigger: "manual" }),
  ).resolves.toEqual({ runId: RUN_ID, deduped: false });
  expect(warn).toHaveBeenCalledWith(
    { error: wakeFailure, runId: RUN_ID },
    "manual pipeline wake failed; job remains queued",
  );
});

it("executes the nine pipeline stages in order and serializes bigint stats", async () => {
  const repo = repository();
  const steps: string[] = [];
  const service = createPipelineService({
    repository: {
      ...repo,
      getRun: vi.fn(async () => ({
        id: RUN_ID,
        userId: USER_ID,
        trigger: "manual" as const,
        status: "running" as const,
        jobId: "job-1",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        steps: [],
      })),
      listSteps: vi.fn(async () => []),
      startStep: vi.fn(async ({ step }: { step: string }) => {
        steps.push(step);
        return { id: step };
      }),
      finishStep: vi.fn(async () => undefined),
      finishRun: vi.fn(async () => undefined),
      finishRunForJob: vi.fn(async () => true),
      reopenRun: vi.fn(async () => undefined),
      reopenRunForJob: vi.fn(async () => true),
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
  await service.executePipelineJob(
    { userId: USER_ID, runId: RUN_ID },
    jobContext(),
  );
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

it("rejects a job whose run does not belong to its payload tenant", async () => {
  const repo = {
    ...repository(),
    getRun: vi.fn(async () => null),
    listSteps: vi.fn(async () => []),
    startStep: vi.fn(),
    finishStep: vi.fn(),
    reopenRun: vi.fn(),
    finishRun: vi.fn(),
  };
  const service = createPipelineService({ repository: repo as never });

  await expect(
    service.executePipelineJob(
      { userId: USER_ID, runId: RUN_ID },
      jobContext(),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" });
  expect(repo.listSteps).not.toHaveBeenCalled();
  expect(repo.startStep).not.toHaveBeenCalled();
  expect(repo.reopenRun).not.toHaveBeenCalled();
  expect(repo.finishRun).not.toHaveBeenCalled();
});

it("rejects stale lease finalization instead of overwriting a terminal run", async () => {
  const repo = {
    ...repository(),
    getRun: vi.fn(async () => ({
      id: RUN_ID,
      userId: USER_ID,
      trigger: "manual" as const,
      status: "running" as const,
      jobId: "job-1",
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
      steps: [],
    })),
    listSteps: vi.fn(async () => []),
    startStep: vi.fn(async ({ step }: { step: string }) => ({ id: step })),
    finishStep: vi.fn(async () => undefined),
    finishRun: vi.fn(async () => undefined),
    finishRunForJob: vi.fn(async () => false),
  };
  const completed = async () => ({ completed: true });
  const service = createPipelineService({
    repository: repo as never,
    stagePorts: {
      plaidSync: completed,
      liabilitiesSync: completed,
      billDetect: completed,
      billMaterialize: completed,
      overdueSweep: completed,
      reconcile: completed,
      balanceRefresh: completed,
      netWorthSnapshot: completed,
      budgetCheck: completed,
    },
  });

  await expect(
    service.executePipelineJob(
      { userId: USER_ID, runId: RUN_ID },
      jobContext(),
    ),
  ).rejects.toThrow("lease no longer owns");
  expect(repo.finishRunForJob).toHaveBeenCalledWith(
    RUN_ID,
    "job-1",
    LEASE_TOKEN,
    "success",
  );
  expect(repo.finishRun).not.toHaveBeenCalled();
});

it("stops before writing a stage result when the job is cancelled", async () => {
  let releaseStage!: () => void;
  const controller = new AbortController();
  const repo = {
    ...repository(),
    getRun: vi.fn(async () => ({
      id: RUN_ID,
      userId: USER_ID,
      trigger: "manual" as const,
      status: "running" as const,
      jobId: "job-1",
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
      steps: [],
    })),
    listSteps: vi.fn(async () => []),
    startStep: vi.fn(async () => ({ id: "plaid_sync" })),
    finishStep: vi.fn(async () => undefined),
    finishRunForJob: vi.fn(async () => true),
  };
  const service = createPipelineService({
    repository: repo as never,
    stagePorts: {
      plaidSync: () =>
        new Promise<Record<string, unknown>>((resolve) => {
          releaseStage = () => resolve({ completed: true });
        }),
    },
  });

  const execution = service.executePipelineJob(
    { userId: USER_ID, runId: RUN_ID },
    jobContext(controller.signal),
  );
  await vi.waitFor(() => expect(repo.startStep).toHaveBeenCalledOnce());
  controller.abort(new Error("lease lost"));
  releaseStage();

  await expect(execution).rejects.toThrow("lease lost");
  expect(repo.finishStep).not.toHaveBeenCalled();
  expect(repo.finishRunForJob).not.toHaveBeenCalled();
});
