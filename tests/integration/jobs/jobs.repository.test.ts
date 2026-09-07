import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "../../../src/platform/database/client.js";
import {
  claimJobs,
  completeJob,
} from "../../../src/platform/jobs/jobs.repository.js";
import { createIsolatedTestDatabase } from "../../support/test-database.js";

const guarded =
  process.env.NODE_ENV === "test" &&
  process.env.DATABASE_ENVIRONMENT === "sandbox" &&
  process.env.ALLOW_SHARED_SANDBOX_TEST_DATABASE === "true" &&
  !!process.env.TEST_DATABASE_URL;

describe.skipIf(!guarded)("jobs repository isolated lease race", () => {
  it("applies 0007 before 0008 and proves SKIP LOCKED progress, expiry, and stale-token rejection", async () => {
    const migrationSql = await readFile(
      "database/migrations/0008_jobs_leases.sql",
      "utf8",
    );
    expect(migrationSql).toContain('UPDATE "jobs"');
    expect(migrationSql).toContain('DROP COLUMN "error"');
    const harness = await createIsolatedTestDatabase();
    let peerA: Awaited<ReturnType<typeof harness.createPeerClient>> | undefined;
    let peerB: Awaited<ReturnType<typeof harness.createPeerClient>> | undefined;
    try {
      peerA = await harness.createPeerClient();
      peerB = await harness.createPeerClient();
      if (!peerA || !peerB) throw new Error("peer sessions were not created");
      const migrationRows = await harness.db.execute<{ hash: string }>(
        sql`SELECT hash FROM __drizzle_migrations ORDER BY id`,
      );
      const migration7 = createHash("sha256")
        .update(
          await readFile(
            "database/migrations/0007_user_data_versions.sql",
            "utf8",
          ),
        )
        .digest("hex");
      const migration8 = createHash("sha256")
        .update(
          await readFile("database/migrations/0008_jobs_leases.sql", "utf8"),
        )
        .digest("hex");
      const hashes = migrationRows.map((row) => row.hash);
      expect(hashes.indexOf(migration8)).toBeGreaterThan(
        hashes.indexOf(migration7),
      );
      const columns = await harness.db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'jobs'
          AND column_name IN ('locked_by', 'lease_token', 'lease_expires_at', 'error_code', 'error')
        ORDER BY column_name
      `);
      expect(columns.map((row) => row.column_name)).toEqual([
        "error_code",
        "lease_expires_at",
        "lease_token",
        "locked_by",
      ]);
      const indexes = await harness.db.execute<{ indexname: string }>(sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'jobs'
      `);
      expect(indexes.map((row) => row.indexname)).toContain(
        "jobs_running_lease_expires_idx",
      );

      const [firstJob, secondJob] = await harness.db
        .insert(schema.jobs)
        .values([
          {
            type: "race",
            payload: {},
            maxAttempts: 3,
            scheduledFor: new Date(1),
          },
          {
            type: "race",
            payload: {},
            maxAttempts: 3,
            scheduledFor: new Date(2),
          },
        ])
        .returning();
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockedPromise = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = peerA.client.begin(async (tx) => {
        await tx`SELECT id FROM jobs WHERE id = ${firstJob!.id} FOR UPDATE`;
        locked();
        await releasePromise;
      });
      await lockedPromise;
      const secondClaim = await claimJobs("worker-b", 1, 300_000, peerB.db);
      expect(secondClaim.map((job) => job.id)).toEqual([secondJob!.id]);
      release();
      await holder;
      const firstClaim = await claimJobs("worker-c", 1, 300_000, peerB.db);
      expect(firstClaim.map((job) => job.id)).toEqual([firstJob!.id]);

      const [singleJob] = await harness.db
        .insert(schema.jobs)
        .values({ type: "single", payload: {}, maxAttempts: 3 })
        .returning();
      const [first, second] = await Promise.all([
        claimJobs("worker-a", 1, 300_000, peerA.db),
        claimJobs("worker-b", 1, 300_000, peerB.db),
      ]);
      const winners = [first[0], second[0]].filter(
        (job) => job?.id === singleJob!.id,
      );
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      await peerA.db
        .update(schema.jobs)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(schema.jobs.id, singleJob!.id));
      const reclaimed = await claimJobs("worker-c", 1, 300_000, peerA.db);
      expect(reclaimed).toHaveLength(1);
      expect(
        await completeJob(singleJob!.id, winner.leaseToken, peerA.db),
      ).toBe(false);
      expect(
        await completeJob(singleJob!.id, reclaimed[0]!.leaseToken, peerA.db),
      ).toBe(true);
    } finally {
      await harness.cleanup();
    }
  }, 120_000);
});
