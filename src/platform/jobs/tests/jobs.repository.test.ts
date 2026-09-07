import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../database/client.js";
import {
  calculateRetryDelayMs,
  enqueueJob,
  claimJobs,
  completeJob,
  retryJob,
  heartbeatJob,
  releaseJob,
  reapExpiredJobs,
} from "../jobs.repository.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "jobs repository contract",
  () => {
    beforeEach(async () => {
      await getDb().delete(schema.jobs);
    });

    it("claims a bounded deterministic batch with an opaque lease", async () => {
      const first = await enqueueJob({
        type: "first",
        payload: {},
        scheduledFor: new Date(1),
      });
      await enqueueJob({
        type: "second",
        payload: {},
        scheduledFor: new Date(2),
      });

      const claimed = await claimJobs("worker-a", 1, 300_000);

      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        id: first.job.id,
        lockedBy: "worker-a",
        attempts: 1,
      });
      expect(claimed[0]?.leaseToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(claimed[0]?.leaseExpiresAt).toBeInstanceOf(Date);
    });

    it("requires the current lease token for all mutations", async () => {
      const { job } = await enqueueJob({ type: "token", payload: {} });
      const [claimed] = await claimJobs("worker-a", 1, 300_000);
      expect(claimed).toBeDefined();

      expect(await completeJob(job.id, "wrong-token")).toBe(false);
      expect(await heartbeatJob(job.id, "wrong-token", 300_000)).toBe(false);
      expect(
        await retryJob(job.id, "wrong-token", "TRANSIENT", new Date()),
      ).toBe(false);
      expect(await releaseJob(job.id, "wrong-token")).toBe(false);
      expect(await completeJob(job.id, claimed!.leaseToken)).toBe(true);
    });

    it("deduplicates active sync jobs and reclaims expired leases", async () => {
      const first = await enqueueJob({
        type: "sync_pipeline",
        payload: { userId: "u-1" },
        uniqueActiveKey: "u-1",
      });
      const second = await enqueueJob({
        type: "sync_pipeline",
        payload: { userId: "u-1" },
        uniqueActiveKey: "u-1",
      });
      expect(second.deduped).toBe(true);
      expect(second.job.id).toBe(first.job.id);

      const [claimed] = await claimJobs("worker-a", 1, 1);
      expect(claimed).toBeDefined();
      const db = getDb();
      await db
        .update(schema.jobs)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(schema.jobs.id, first.job.id));
      const [reclaimed] = await claimJobs("worker-b", 1, 300_000);
      expect(reclaimed?.lockedBy).toBe("worker-b");
      expect(reclaimed?.leaseToken).not.toBe(claimed?.leaseToken);
      expect(await completeJob(first.job.id, claimed!.leaseToken)).toBe(false);
    });

    it("reaps only expired running jobs", async () => {
      const { job } = await enqueueJob({ type: "stale", payload: {} });
      const [claimed] = await claimJobs("worker-a", 1, 300_000);
      expect(claimed).toBeDefined();
      await getDb()
        .update(schema.jobs)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(schema.jobs.id, job.id));
      expect(await reapExpiredJobs(new Date())).toBe(1);
    });
  },
);

describe("retry policy", () => {
  it("uses 30-second exponential retry with injectable 0-25% jitter", () => {
    expect(calculateRetryDelayMs(1, () => 0)).toBe(30_000);
    expect(calculateRetryDelayMs(2, () => 1)).toBe(75_000);
    expect(calculateRetryDelayMs(20, () => 1)).toBe(4_500_000);
    expect(() => calculateRetryDelayMs(0)).toThrow("attempt");
  });
});
