import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { schema } from "../../../src/platform/database/client.js";
import { createJobsRepository } from "../../../src/platform/jobs/jobs.repository.js";
import { createPipelineRepository } from "../../../src/modules/pipeline/pipeline.repository.js";
import { createIsolatedTestDatabase } from "../../support/test-database.js";

const guarded =
  process.env.NODE_ENV === "test" &&
  process.env.DATABASE_ENVIRONMENT === "sandbox" &&
  process.env.ALLOW_SHARED_SANDBOX_TEST_DATABASE === "true" &&
  !!process.env.TEST_DATABASE_URL;

describe.skipIf(!guarded)("expired pipeline job recovery", () => {
  it("fails a running pipeline without overwriting a completed run", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const completedUserId = randomUUID();
      const runningUserId = randomUUID();
      await harness.db.insert(schema.users).values([
        {
          id: completedUserId,
          email: `${completedUserId}@example.test`,
        },
        { id: runningUserId, email: `${runningUserId}@example.test` },
      ]);
      const pipelines = createPipelineRepository(harness.db);
      const completedRun = await pipelines.createRun({
        userId: completedUserId,
        trigger: "manual",
      });
      await pipelines.finishRun(completedRun.id, "success");
      const runningRun = await pipelines.createRun({
        userId: runningUserId,
        trigger: "manual",
      });
      let runningJobId = "";
      for (const [userId, runId] of [
        [completedUserId, completedRun.id],
        [runningUserId, runningRun.id],
      ] as const) {
        const jobId = randomUUID();
        if (runId === runningRun.id) runningJobId = jobId;
        await harness.db.insert(schema.jobs).values({
          id: jobId,
          userId,
          type: "sync_pipeline",
          payload: { userId, runId },
          status: "running",
          attempts: 3,
          maxAttempts: 3,
          lockedBy: "dead-worker",
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date("2000-01-01T00:00:00Z"),
        });
        await pipelines.setRunJob(runId, jobId);
      }
      const jobs = createJobsRepository({
        db: harness.db,
        async onTerminalExpiredJob(job, tx) {
          const payload = job.payload as { runId: string };
          await pipelines.failRunForExpiredJob(payload.runId, job.id, tx);
        },
      });

      await jobs.reapExpiredJobs();

      expect(
        await pipelines.finishRunForJob(
          runningRun.id,
          runningJobId,
          "stale-lease-token",
          "success",
        ),
      ).toBe(false);

      expect(
        await pipelines.getRun(completedUserId, completedRun.id),
      ).toMatchObject({ status: "success" });
      expect(
        await pipelines.getRun(runningUserId, runningRun.id),
      ).toMatchObject({ status: "failed" });
    } finally {
      await harness.cleanup();
    }
  }, 120_000);
});
