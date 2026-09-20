import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJobsPoller } from "../jobs-poller.js";

const {
  claimJobs,
  completeJob,
  failJob,
  retryJob,
  heartbeatJob,
  releaseJob,
  enqueueJob,
  reapExpiredJobs,
} = vi.hoisted(() => ({
  claimJobs: vi.fn(),
  enqueueJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  retryJob: vi.fn(),
  heartbeatJob: vi.fn(),
  releaseJob: vi.fn(),
  reapExpiredJobs: vi.fn(),
}));
const repository = {
  claimJobs,
  completeJob,
  failJob,
  retryJob,
  heartbeatJob,
  releaseJob,
  enqueueJob,
  reapExpiredJobs,
};

vi.mock("../jobs.repository.js", () => ({
  claimJobs,
  completeJob,
  failJob,
  retryJob,
  heartbeatJob,
  releaseJob,
  calculateRetryDelayMs: vi.fn(() => 30_000),
}));

describe("jobs poller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it("drains every eligible batch once and remains idle after completion", async () => {
    const handled: string[] = [];
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "first",
          type: "known",
          payload: { value: "first" },
          attempts: 1,
          maxAttempts: 3,
          leaseToken: "lease-first",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "second",
          type: "known",
          payload: { value: "second" },
          attempts: 1,
          maxAttempts: 3,
          leaseToken: "lease-second",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    completeJob.mockResolvedValue(true);
    const poller = createJobsPoller({
      workerId: "worker",
      repository,
      concurrency: 1,
      handlers: {
        known: async (payload: Record<string, unknown>) => {
          handled.push(String(payload.value));
        },
      },
    });

    await Promise.all([poller.drainOnce(), poller.drainOnce()]);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);

    expect(handled).toEqual(["first", "second"]);
    expect(claimJobs).toHaveBeenCalledTimes(3);
    expect(completeJob).toHaveBeenCalledTimes(2);
    await poller.stop();
  });

  it("isolates handler failures, stores a safe code, and drains newly available work", async () => {
    let calls = 0;
    claimJobs.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return [
          {
            id: "a",
            type: "known",
            payload: {},
            attempts: 1,
            maxAttempts: 3,
            leaseToken: "a",
            leaseExpiresAt: new Date(),
            lockedBy: "worker",
          },
        ];
      }
      if (calls === 2) {
        return [
          {
            id: "b",
            type: "unknown",
            payload: {},
            attempts: 1,
            maxAttempts: 3,
            leaseToken: "b",
            leaseExpiresAt: new Date(),
            lockedBy: "worker",
          },
        ];
      }
      return [];
    });
    const handler = vi.fn(async () => {
      throw new Error("secret stack and token");
    });
    const poller = createJobsPoller({
      workerId: "worker",
      repository,
      handlers: { known: handler },
      pollMs: 10,
      concurrency: 1,
      heartbeatMs: 100,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(retryJob).toHaveBeenCalledWith(
      "a",
      "a",
      expect.any(String),
      expect.any(Date),
    );
    expect(String(retryJob.mock.calls[0]?.[2])).not.toContain("secret");
    expect(failJob).toHaveBeenCalledWith("b", "b", "MISSING_HANDLER");
    await poller.stop();
  });

  it("prevents new claims and waits for active handlers on stop", async () => {
    let finish!: () => void;
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "a",
          type: "known",
          payload: {},
          attempts: 1,
          maxAttempts: 1,
          leaseToken: "a",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = createJobsPoller({
      workerId: "worker",
      repository,
      handlers: { known: handler },
      pollMs: 10,
      concurrency: 1,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    const stopping = poller.stop();
    expect(
      await Promise.race([
        stopping.then(() => "stopped"),
        Promise.resolve("waiting"),
      ]),
    ).toBe("waiting");
    finish();
    await stopping;
    expect(claimJobs).toHaveBeenCalledTimes(1);
  });

  it("does not release a handler claim when stop is reentered synchronously", async () => {
    const pollerRef: { current?: ReturnType<typeof createJobsPoller> } = {};
    let stopPromise!: Promise<void>;
    const firstHandler = vi.fn(() => {
      stopPromise = pollerRef.current!.stop();
      return Promise.resolve();
    });
    const secondHandler = vi.fn(async () => undefined);
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "started",
          type: "first",
          payload: {},
          attempts: 1,
          maxAttempts: 3,
          leaseToken: "started-token",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
        {
          id: "not-started",
          type: "second",
          payload: {},
          attempts: 1,
          maxAttempts: 3,
          leaseToken: "not-started-token",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    releaseJob.mockResolvedValue(true);
    pollerRef.current = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: { first: firstHandler, second: secondHandler },
      pollMs: 1000,
      leaseMs: 100,
      shutdownTimeoutMs: 10,
      concurrency: 2,
    });
    pollerRef.current.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await stopPromise;
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
    expect(releaseJob).toHaveBeenCalledOnce();
    expect(releaseJob).toHaveBeenCalledWith("not-started", "not-started-token");
  });

  it("bounds a handler that awaits its own shutdown", async () => {
    let selfStop!: Promise<void>;
    const pollerRef: { current?: ReturnType<typeof createJobsPoller> } = {};
    const handler = vi.fn(async () => {
      selfStop = pollerRef.current!.stop();
      await selfStop;
    });
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "self-stop",
          type: "known",
          payload: {},
          attempts: 1,
          maxAttempts: 1,
          leaseToken: "self-stop-token",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    pollerRef.current = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: { known: handler },
      pollMs: 1000,
      leaseMs: 100,
      shutdownTimeoutMs: 10,
    });
    pollerRef.current.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await selfStop;
    expect(completeJob).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
    expect(releaseJob).not.toHaveBeenCalled();
  });

  it("treats a false heartbeat as lost ownership and never retries stale work", async () => {
    let finish!: () => void;
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "lease",
          type: "known",
          payload: {},
          attempts: 1,
          maxAttempts: 3,
          leaseToken: "lease",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    heartbeatJob.mockResolvedValue(false);
    const handler = vi.fn(
      (
        _payload: Record<string, unknown>,
        { signal }: { signal: AbortSignal },
      ) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              finish = resolve;
            },
            { once: true },
          );
        }),
    );
    const poller = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: { known: handler },
      pollMs: 1000,
      heartbeatMs: 10,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(handler).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(completeJob).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
  });

  it("terminally rejects non-function handlers and non-plain payloads", async () => {
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "bad-handler",
          type: "missing",
          payload: {},
          attempts: 1,
          maxAttempts: 1,
          leaseToken: "a",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
        {
          id: "bad-payload",
          type: "known",
          payload: new Date(),
          attempts: 1,
          maxAttempts: 1,
          leaseToken: "b",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    const poller = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: { missing: "not-a-function", known: vi.fn() },
      pollMs: 1000,
      concurrency: 2,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(failJob).toHaveBeenCalledWith("bad-handler", "a", "MISSING_HANDLER");
    expect(failJob).toHaveBeenCalledWith("bad-payload", "b", "INVALID_PAYLOAD");
  });

  it("bounds shutdown, aborts cooperative handlers, and leaves ignored handlers leased", async () => {
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "slow",
          type: "known",
          payload: {},
          attempts: 1,
          maxAttempts: 1,
          leaseToken: "slow",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    const handler = vi.fn(() => new Promise<void>(() => undefined));
    const poller = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: { known: handler },
      pollMs: 1000,
      leaseMs: 100,
      shutdownTimeoutMs: 10,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    const stopping = poller.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(releaseJob).not.toHaveBeenCalled();
  });

  it("releases every claim that resolves after shutdown starts and shares its bounded stop promise", async () => {
    let resolveClaim!: (jobs: unknown[]) => void;
    claimJobs.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const poller = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: {},
      pollMs: 10,
      leaseMs: 100,
      shutdownTimeoutMs: 10,
    });
    poller.start();
    await Promise.resolve();
    const firstStop = poller.stop();
    expect(poller.stop()).toBe(firstStop);
    await vi.advanceTimersByTimeAsync(10);
    await firstStop;

    resolveClaim([
      { id: "late-a", leaseToken: "token-a" },
      { id: "late-b", leaseToken: "token-b" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseJob).toHaveBeenNthCalledWith(1, "late-a", "token-a");
    expect(releaseJob).toHaveBeenNthCalledWith(2, "late-b", "token-b");
  });

  it("attempts every late release even when one release fails", async () => {
    let resolveClaim!: (jobs: unknown[]) => void;
    claimJobs.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    releaseJob
      .mockRejectedValueOnce(new Error("release connection secret"))
      .mockResolvedValueOnce(true);
    const poller = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: {},
      pollMs: 10,
      leaseMs: 100,
      shutdownTimeoutMs: 10,
    });
    poller.start();
    await Promise.resolve();
    const stopping = poller.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    resolveClaim([
      { id: "rejected-release", leaseToken: "token-a" },
      { id: "successful-release", leaseToken: "token-b" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseJob).toHaveBeenCalledTimes(2);
    expect(releaseJob).toHaveBeenNthCalledWith(
      2,
      "successful-release",
      "token-b",
    );
  });

  it("treats heartbeat errors as lost ownership and never mutates a stale lease", async () => {
    let finish!: () => void;
    claimJobs
      .mockResolvedValueOnce([
        {
          id: "heartbeat-error",
          type: "known",
          payload: {},
          attempts: 1,
          maxAttempts: 3,
          leaseToken: "heartbeat-token",
          leaseExpiresAt: new Date(),
          lockedBy: "worker",
        },
      ])
      .mockResolvedValue([]);
    heartbeatJob.mockRejectedValue(new Error("connection secret"));
    const handler = vi.fn(
      (
        _payload: Record<string, unknown>,
        { signal }: { signal: AbortSignal },
      ) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              finish = resolve;
            },
            { once: true },
          );
        }),
    );
    const poller = createJobsPoller({
      repository,
      workerId: "worker",
      handlers: { known: handler },
      pollMs: 1000,
      heartbeatMs: 10,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(completeJob).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
  });

  it("requires integer timer values and a heartbeat shorter than the lease", () => {
    const base = {
      repository,
      workerId: "worker",
      handlers: {},
    };
    expect(() => createJobsPoller({ ...base, pollMs: 1.5 })).toThrow("pollMs");
    expect(() =>
      createJobsPoller({ ...base, leaseMs: 100, heartbeatMs: 10.5 }),
    ).toThrow("heartbeatMs");
    expect(() =>
      createJobsPoller({ ...base, leaseMs: 100, heartbeatMs: 100 }),
    ).toThrow("less than leaseMs");
  });
});
