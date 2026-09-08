import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "../../../src/platform/database/client.js";
import {
  claimJobs,
  completeJob,
  enqueueJob,
} from "../../../src/platform/jobs/jobs.repository.js";
import { createIsolatedTestDatabase } from "../../support/test-database.js";
import { quoteIdentifier } from "../../../database/migrate.js";
import type { Db } from "../../../src/platform/database/types.js";

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
    let releaseHolder: (() => void) | undefined;
    let holder: Promise<unknown> | undefined;
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

      // migrateSchema has already applied 0008. Recreate the legacy shape in
      // this isolated schema, seed abandoned rows, and execute the real file
      // again so the cutover behavior is exercised rather than inspected.
      const requeuedId = randomUUID();
      const exhaustedId = randomUUID();
      const validUserId = randomUUID();
      const foreignUserId = randomUUID();
      const orphanTenantId = randomUUID();
      const validSyncId = randomUUID();
      const mismatchedSyncId = randomUUID();
      const nullTenantSyncId = randomUUID();
      const invalidTenantSyncId = randomUUID();
      const quotedSchema = quoteIdentifier(harness.schemaName);
      await peerA.client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO ${quotedSchema}`);
        await tx.unsafe(
          'DROP INDEX IF EXISTS "jobs_running_lease_expires_idx"',
        );
        await tx.unsafe('ALTER TABLE "jobs" DROP COLUMN "locked_by"');
        await tx.unsafe('ALTER TABLE "jobs" DROP COLUMN "lease_token"');
        await tx.unsafe('ALTER TABLE "jobs" DROP COLUMN "lease_expires_at"');
        await tx.unsafe('ALTER TABLE "jobs" DROP COLUMN "error_code"');
        await tx.unsafe('ALTER TABLE "jobs" ADD COLUMN "error" text');
        await tx.unsafe(
          'INSERT INTO "users" ("id", "email") VALUES ($1, $2), ($3, $4)',
          [
            validUserId,
            `${validUserId}@example.test`,
            foreignUserId,
            `${foreignUserId}@example.test`,
          ],
        );
        await tx.unsafe(
          `INSERT INTO "jobs"
            ("id", "user_id", "type", "payload", "status", "attempts", "max_attempts", "scheduled_for", "error")
           VALUES ($1, NULL, 'legacy', '{}'::jsonb, 'running', 1, 3, '2000-01-01T00:00:00Z', $7),
                  ($2, NULL, 'legacy', '{}'::jsonb, 'running', 3, 3, '2000-01-01T00:00:00Z', $7),
                  ($3, $8, 'sync_pipeline', $9::jsonb, 'running', 1, 3, '2000-01-01T00:00:00Z', $7),
                  ($4, $8, 'sync_pipeline', $10::jsonb, 'running', 1, 3, '2000-01-01T00:00:00Z', $7),
                  ($5, NULL, 'sync_pipeline', $12::jsonb, 'pending', 0, 3, '2000-01-01T00:00:00Z', $7),
                  ($6, $8, 'sync_pipeline', $11::jsonb, 'running', 1, 3, '2000-01-01T00:00:00Z', $7)`,
          [
            requeuedId,
            exhaustedId,
            validSyncId,
            mismatchedSyncId,
            nullTenantSyncId,
            invalidTenantSyncId,
            "secret legacy stack",
            validUserId,
            JSON.stringify({ userId: validUserId }),
            JSON.stringify({ userId: foreignUserId }),
            JSON.stringify({ userId: "not-a-uuid" }),
            JSON.stringify({ userId: orphanTenantId }),
          ],
        );
      });
      const statements = migrationSql
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      await peerA.client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO ${quotedSchema}`);
        for (const statement of statements) await tx.unsafe(statement);
      });
      const migrated = await harness.db.execute<{
        id: string;
        status: string;
        scheduled_for: Date;
        completed_at: Date | null;
        error_code: string | null;
        locked_by: string | null;
        lease_token: string | null;
        lease_expires_at: Date | null;
      }>(sql`
        SELECT id, status, scheduled_for, completed_at, error_code,
          locked_by, lease_token, lease_expires_at
        FROM jobs WHERE id IN (${requeuedId}, ${exhaustedId}) ORDER BY id
      `);
      const requeued = migrated.find((row) => row.id === requeuedId);
      const exhausted = migrated.find((row) => row.id === exhaustedId);
      expect(requeued).toMatchObject({
        status: "pending",
        completed_at: null,
        error_code: "LEGACY_RUNNING_REQUEUED",
        locked_by: null,
        lease_token: null,
        lease_expires_at: null,
      });
      expect(new Date(requeued!.scheduled_for).getTime()).toBeGreaterThan(
        new Date("2000-01-01T00:00:00Z").getTime(),
      );
      expect(exhausted).toMatchObject({
        status: "failed",
        error_code: "LEGACY_RUNNING_EXHAUSTED",
        locked_by: null,
        lease_token: null,
        lease_expires_at: null,
      });
      expect(exhausted?.completed_at).not.toBeNull();
      const migratedSync = await harness.db.execute<{
        id: string;
        status: string;
        completed_at: Date | null;
        error_code: string | null;
        locked_by: string | null;
        lease_token: string | null;
        lease_expires_at: Date | null;
      }>(sql`
        SELECT id, status, completed_at, error_code,
          locked_by, lease_token, lease_expires_at
        FROM jobs
        WHERE id IN (${validSyncId}, ${mismatchedSyncId}, ${nullTenantSyncId}, ${invalidTenantSyncId})
        ORDER BY id
      `);
      const bySyncId = new Map(migratedSync.map((row) => [row.id, row]));
      expect(bySyncId.get(validSyncId)).toMatchObject({
        status: "pending",
        completed_at: null,
        error_code: "LEGACY_RUNNING_REQUEUED",
        locked_by: null,
        lease_token: null,
        lease_expires_at: null,
      });
      for (const id of [
        mismatchedSyncId,
        nullTenantSyncId,
        invalidTenantSyncId,
      ]) {
        expect(bySyncId.get(id)).toMatchObject({
          status: "failed",
          error_code: "TENANT_IDENTITY_MISMATCH",
          locked_by: null,
          lease_token: null,
          lease_expires_at: null,
        });
        expect(bySyncId.get(id)?.completed_at).not.toBeNull();
      }
      await peerA.client`
        DELETE FROM jobs WHERE id IN (
          ${requeuedId}, ${exhaustedId}, ${validSyncId},
          ${mismatchedSyncId}, ${nullTenantSyncId}, ${invalidTenantSyncId}
        )
      `;
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
      holder = peerA.client.begin(async (tx) => {
        await tx`SELECT id FROM jobs WHERE id = ${firstJob!.id} FOR UPDATE`;
        locked();
        await releasePromise;
      });
      await lockedPromise;
      releaseHolder = release;
      const secondClaimPromise = claimJobs("worker-b", 1, 300_000, peerB.db);
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error("SKIP LOCKED claim blocked")),
          2_000,
        );
      });
      let secondClaim;
      try {
        secondClaim = await Promise.race([secondClaimPromise, timeout]);
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      }
      expect(secondClaim.map((job) => job.id)).toEqual([secondJob!.id]);
      release();
      await holder;
      releaseHolder = undefined;
      const firstClaim = await claimJobs("worker-c", 1, 300_000, peerB.db);
      expect(firstClaim.map((job) => job.id)).toEqual([firstJob!.id]);

      const [singleJob] = await harness.db
        .insert(schema.jobs)
        .values({ type: "single", payload: {}, maxAttempts: 3 })
        .returning();
      let ready = 0;
      let releaseReady!: () => void;
      const readyBarrier = new Promise<void>((resolve) => {
        releaseReady = resolve;
      });
      const claimWhenReady = async (workerId: string, db: Db) => {
        ready += 1;
        if (ready === 2) releaseReady();
        await readyBarrier;
        return claimJobs(workerId, 1, 300_000, db);
      };
      const [first, second] = await Promise.all([
        claimWhenReady("worker-a", peerA.db),
        claimWhenReady("worker-b", peerB.db),
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

      let enqueueReady = 0;
      let releaseEnqueueReady!: () => void;
      const enqueueBarrier = new Promise<void>((resolve) => {
        releaseEnqueueReady = resolve;
      });
      const enqueueWhenReady = async (db: Db) => {
        enqueueReady += 1;
        if (enqueueReady === 2) releaseEnqueueReady();
        await enqueueBarrier;
        return enqueueJob(
          {
            type: "sync_pipeline",
            payload: { userId: validUserId },
          },
          db,
        );
      };
      const concurrentEnqueues = Promise.all([
        enqueueWhenReady(peerA.db),
        enqueueWhenReady(peerB.db),
      ]);
      let enqueueTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const enqueueTimeout = new Promise<never>((_, reject) => {
        enqueueTimeoutTimer = setTimeout(
          () => reject(new Error("concurrent enqueue timed out")),
          5_000,
        );
      });
      let enqueued: Awaited<typeof concurrentEnqueues>;
      try {
        enqueued = await Promise.race([concurrentEnqueues, enqueueTimeout]);
      } finally {
        if (enqueueTimeoutTimer !== undefined)
          clearTimeout(enqueueTimeoutTimer);
      }
      expect(enqueued.map((result) => result.deduped).sort()).toEqual([
        false,
        true,
      ]);
      expect(new Set(enqueued.map((result) => result.job.id)).size).toBe(1);
      const activeSyncCount = await harness.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM jobs
        WHERE type = 'sync_pipeline'
          AND status IN ('pending', 'running')
          AND user_id = ${validUserId}
      `);
      expect(activeSyncCount[0]?.count).toBe("1");
    } finally {
      releaseHolder?.();
      if (holder) await holder.catch(() => undefined);
      await harness.cleanup();
    }
  }, 120_000);
});
