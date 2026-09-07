import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "../../../src/platform/database/client.js";
import {
  claimJobs,
  completeJob,
} from "../../../src/platform/jobs/jobs.repository.js";
import {
  createIsolatedTestDatabase,
  waitForBlockedBackend,
} from "../../support/test-database.js";

const guarded =
  process.env.NODE_ENV === "test" &&
  process.env.DATABASE_ENVIRONMENT === "sandbox" &&
  process.env.ALLOW_SHARED_SANDBOX_TEST_DATABASE === "true" &&
  !!process.env.TEST_DATABASE_URL;

describe.skipIf(!guarded)("jobs repository isolated lease race", () => {
  it("applies 0007 before 0008 and proves peer contention, expiry, and stale-token rejection", async () => {
    const harness = await createIsolatedTestDatabase();
    const peerA = await harness.createPeerClient();
    const peerB = await harness.createPeerClient();
    const observer = await harness.createPeerClient();
    try {
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
      expect(hashes.indexOf(migration7)).toBeGreaterThanOrEqual(0);
      expect(hashes.indexOf(migration8)).toBeGreaterThan(
        hashes.indexOf(migration7),
      );

      const [job] = await harness.db
        .insert(schema.jobs)
        .values({ type: "race", payload: {}, maxAttempts: 3 })
        .returning();
      expect(job).toBeDefined();
      const [first, second] = await Promise.all([
        claimJobs("worker-a", 1, 300_000, peerA.db),
        claimJobs("worker-b", 1, 300_000, peerB.db),
      ]);
      const winner = first[0] ?? second[0];
      expect([first[0], second[0]].filter(Boolean)).toHaveLength(1);
      expect(winner).toBeDefined();

      await peerA.db
        .update(schema.jobs)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(schema.jobs.id, job!.id));
      const reclaimed = await claimJobs("worker-c", 1, 300_000, peerA.db);
      expect(reclaimed).toHaveLength(1);
      expect(await completeJob(job!.id, winner!.leaseToken, peerA.db)).toBe(
        false,
      );

      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderPid!: number;
      let waiterPid!: number;
      const holder = peerA.client.begin(async (tx) => {
        const rows = await tx`SELECT pg_backend_pid() AS pid`;
        holderPid = Number(rows[0]?.pid);
        await tx`SELECT id FROM jobs WHERE id = ${job!.id} FOR UPDATE`;
        await releasePromise;
      });
      while (!holderPid) await new Promise((resolve) => setTimeout(resolve, 5));
      const waiter = peerB.client.begin(async (tx) => {
        const rows = await tx`SELECT pg_backend_pid() AS pid`;
        waiterPid = Number(rows[0]?.pid);
        await tx`UPDATE jobs SET error_code = 'CONTENDED' WHERE id = ${job!.id}`;
      });
      while (!waiterPid) await new Promise((resolve) => setTimeout(resolve, 5));
      await waitForBlockedBackend(observer.client, waiterPid, holderPid);
      release();
      await Promise.all([holder, waiter]);
    } finally {
      await harness.cleanup();
    }
  });
});
