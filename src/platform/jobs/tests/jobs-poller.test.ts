import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJobsPoller } from "../jobs-poller.js";

const { claimJobs, completeJob, failJob, retryJob, heartbeatJob, releaseJob } =
  vi.hoisted(() => ({
    claimJobs: vi.fn(),
    completeJob: vi.fn(),
    failJob: vi.fn(),
    retryJob: vi.fn(),
    heartbeatJob: vi.fn(),
    releaseJob: vi.fn(),
  }));

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
});
