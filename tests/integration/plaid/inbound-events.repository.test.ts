import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createInboundEventsRepository } from "../../../src/modules/plaid/inbound-events.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

guardedDescribe("inbound webhook event repository", () => {
  it("repairs pre-0010 lifecycle rows and rejects permanently unclaimable leases", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const peer = await harness.createPeerClient();
      const repository = createInboundEventsRepository(harness.db);
      const malformedLease = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "malformed-lease-item",
        payload: {},
        payloadDigest: "digest-malformed-lease",
        dedupeKey: "dedupe-malformed-lease",
      });
      const partialLease = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "partial-lease-item",
        payload: {},
        payloadDigest: "digest-partial-lease",
        dedupeKey: "dedupe-partial-lease",
      });
      const validLegacyLease = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "valid-legacy-lease-item",
        payload: {},
        payloadDigest: "digest-valid-legacy-lease",
        dedupeKey: "dedupe-valid-legacy-lease",
      });
      const malformedPending = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "malformed-pending-item",
        payload: {},
        payloadDigest: "digest-malformed-pending",
        dedupeKey: "dedupe-malformed-pending",
      });

      await peer.client.begin(async (tx) => {
        await tx.unsafe(
          'ALTER TABLE "inbound_webhook_events" DROP CONSTRAINT "inbound_webhook_events_lease_check"',
        );
        await tx.unsafe(
          'ALTER TABLE "inbound_webhook_events" DROP CONSTRAINT "inbound_webhook_events_attempts_check"',
        );
        await tx.unsafe(
          'ALTER TABLE "inbound_webhook_events" DROP COLUMN "lease_token"',
        );
        await tx.unsafe(
          `UPDATE "inbound_webhook_events"
           SET status = 'processing', attempts = 2, locked_by = ' ',
               lease_expires_at = 'infinity', processed_at = now()
           WHERE id = $1`,
          [malformedLease.id],
        );
        await tx.unsafe(
          `UPDATE "inbound_webhook_events"
           SET status = 'processing', attempts = 1, locked_by = NULL,
               lease_expires_at = now() + interval '5 minutes'
           WHERE id = $1`,
          [partialLease.id],
        );
        await tx.unsafe(
          `UPDATE "inbound_webhook_events"
           SET status = 'processing', attempts = 1, locked_by = 'legacy-worker',
               lease_expires_at = now() + interval '5 minutes'
           WHERE id = $1`,
          [validLegacyLease.id],
        );
        await tx.unsafe(
          `UPDATE "inbound_webhook_events"
           SET attempts = -1, locked_by = 'stray-worker',
               lease_expires_at = now() + interval '5 minutes'
           WHERE id = $1`,
          [malformedPending.id],
        );
      });

      const migrationSql = await readFile(
        "database/migrations/0010_inbound_event_lease_fencing.sql",
        "utf8",
      );
      const statements = migrationSql
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      await peer.client.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement);
      });

      expect(await repository.findById(malformedLease.id)).toMatchObject({
        status: "pending",
        attempts: 2,
        lockedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processedAt: null,
      });
      expect(await repository.findById(partialLease.id)).toMatchObject({
        status: "pending",
        lockedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(await repository.findById(validLegacyLease.id)).toMatchObject({
        status: "processing",
        lockedBy: "legacy-worker",
      });
      expect(
        (await repository.findById(validLegacyLease.id))?.leaseToken,
      ).toMatch(/^[0-9a-f-]{36}$/);
      expect(await repository.findById(malformedPending.id)).toMatchObject({
        status: "pending",
        attempts: 0,
        lockedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });

      await expect(
        harness.db.execute(sql`
          UPDATE inbound_webhook_events
          SET status = 'processing', locked_by = ' ',
              lease_token = gen_random_uuid()::text,
              lease_expires_at = 'infinity'
          WHERE id = ${malformedPending.id}
        `),
      ).rejects.toBeDefined();

      const sharedLeaseToken = "11111111-1111-4111-8111-111111111111";
      await harness.db.execute(sql`
        UPDATE inbound_webhook_events
        SET status = 'processing', locked_by = 'worker-a',
            lease_token = ${sharedLeaseToken},
            lease_expires_at = now() + interval '5 minutes'
        WHERE id = ${partialLease.id}
      `);
      await expect(
        harness.db.execute(sql`
          UPDATE inbound_webhook_events
          SET status = 'processing', locked_by = 'worker-b',
              lease_token = ${sharedLeaseToken},
              lease_expires_at = now() + interval '5 minutes'
          WHERE id = ${malformedPending.id}
        `),
      ).rejects.toBeDefined();

      const centsyCompatibleId = randomUUID();
      await expect(
        harness.db.execute(sql`
          INSERT INTO inbound_webhook_events (
            id, provider, webhook_type, webhook_code, provider_item_id,
            payload, payload_digest, dedupe_key, status, attempts, available_at
          ) VALUES (
            ${centsyCompatibleId}, 'plaid', 'ITEM', 'ERROR', 'centsy-item',
            '{}'::jsonb, 'digest-centsy', 'dedupe-centsy', 'pending', 0, now()
          )
        `),
      ).resolves.toBeDefined();
      expect(await repository.findById(centsyCompatibleId)).toMatchObject({
        status: "pending",
        leaseToken: null,
      });
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("claims one durable delivery across concurrent workers and supports dead replay", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const repository = createInboundEventsRepository(harness.db);
      const peerA = await harness.createPeerClient();
      const peerB = await harness.createPeerClient();
      const workerA = createInboundEventsRepository(peerA.db);
      const workerB = createInboundEventsRepository(peerB.db);
      const created = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "TRANSACTIONS",
        webhookCode: "SYNC_UPDATES_AVAILABLE",
        providerItemId: "item-1",
        payload: { webhook_type: "TRANSACTIONS" },
        payloadDigest: "digest",
        dedupeKey: "dedupe",
      });
      const [first, second] = await Promise.all([
        workerA.claimInboundEvents("worker-a", 1),
        workerB.claimInboundEvents("worker-b", 1),
      ]);
      const claimed = [...first, ...second];
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(created.id);
      expect(
        await repository.markDead(
          created.id,
          claimed[0]!.lockedBy,
          claimed[0]!.attempts,
          claimed[0]!.leaseToken,
          "provider failure",
        ),
      ).toBe(true);
      expect(await repository.replayDeadEvent(created.id)).toMatchObject({
        id: created.id,
        status: "pending",
        attempts: 0,
      });
      const replayClaim = await repository.claimInboundEvents("worker-c", 1);
      expect(replayClaim).toHaveLength(1);
      expect(
        await repository.releaseInboundEvent(
          created.id,
          "worker-c",
          replayClaim[0]!.attempts,
          replayClaim[0]!.leaseToken,
        ),
      ).toBe(true);
      expect(
        await repository.releaseInboundEvent(
          created.id,
          "worker-c",
          replayClaim[0]!.attempts,
          replayClaim[0]!.leaseToken,
        ),
      ).toBe(false);
      const reclaimed = await repository.claimInboundEvents("worker-d", 1);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.attempts).toBe(1);
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("rejects a stale completion after the same worker identity reclaims the lease", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const repository = createInboundEventsRepository(harness.db);
      const created = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "TRANSACTIONS",
        webhookCode: "SYNC_UPDATES_AVAILABLE",
        providerItemId: "item-1",
        payload: { webhook_type: "TRANSACTIONS" },
        payloadDigest: "digest-stale",
        dedupeKey: "dedupe-stale",
      });
      const first = await repository.claimInboundEvents("stable-worker", 1);
      await harness.db.execute(
        sql`UPDATE inbound_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE id = ${created.id}`,
      );
      const reclaimed = await repository.claimInboundEvents("stable-worker", 1);

      expect(first[0]?.attempts).toBe(1);
      expect(reclaimed[0]?.attempts).toBe(2);
      expect(
        await repository.markProcessed(
          created.id,
          "stable-worker",
          1,
          first[0]!.leaseToken,
        ),
      ).toBe(false);
      expect(
        await repository.markProcessed(
          created.id,
          "stable-worker",
          2,
          reclaimed[0]!.leaseToken,
        ),
      ).toBe(true);
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("rejects an ABA stale completion after dead replay and same-worker reclaim", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const repository = createInboundEventsRepository(harness.db);
      const created = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "TRANSACTIONS",
        webhookCode: "SYNC_UPDATES_AVAILABLE",
        providerItemId: "aba-item",
        payload: {},
        payloadDigest: "digest-aba",
        dedupeKey: "dedupe-aba",
      });
      const stale = await repository.claimInboundEvents("stable-worker", 1);
      await harness.db.execute(sql`
        UPDATE inbound_webhook_events
        SET attempts = 8, lease_expires_at = now() - interval '1 second'
        WHERE id = ${created.id}
      `);
      await repository.claimInboundEvents("reaper", 1);
      await repository.replayDeadEvent(created.id);
      const current = await repository.claimInboundEvents("stable-worker", 1);

      expect(stale[0]?.attempts).toBe(1);
      expect(current[0]?.attempts).toBe(1);
      expect(
        await repository.markProcessed(
          created.id,
          "stable-worker",
          1,
          stale[0]!.leaseToken,
        ),
      ).toBe(false);
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("rejects malformed inbound-event lifecycle state", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const repository = createInboundEventsRepository(harness.db);
      const created = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "malformed-item",
        payload: {},
        payloadDigest: "digest-malformed",
        dedupeKey: "dedupe-malformed",
      });
      await expect(
        harness.db.execute(sql`
          UPDATE inbound_webhook_events SET attempts = -1 WHERE id = ${created.id}
        `),
      ).rejects.toBeDefined();
      await expect(
        harness.db.execute(sql`
          UPDATE inbound_webhook_events
          SET status = 'processing', locked_by = 'worker', lease_expires_at = NULL
          WHERE id = ${created.id}
        `),
      ).rejects.toBeDefined();
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("allows only one concurrent claim for the same Plaid item across sessions", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const peerA = await harness.createPeerClient();
      const peerB = await harness.createPeerClient();
      const repository = createInboundEventsRepository(harness.db);
      const workerA = createInboundEventsRepository(peerA.db);
      const workerB = createInboundEventsRepository(peerB.db);
      for (const suffix of ["first", "second"]) {
        await repository.insert({
          id: randomUUID(),
          provider: "plaid",
          webhookType: "ITEM",
          webhookCode: suffix === "first" ? "ERROR" : "LOGIN_REPAIRED",
          providerItemId: "same-item",
          payload: { suffix },
          payloadDigest: `digest-${suffix}`,
          dedupeKey: `dedupe-${suffix}`,
        });
      }

      const claims = await Promise.all([
        workerA.claimInboundEvents("worker-a", 2),
        workerB.claimInboundEvents("worker-b", 2),
      ]);
      const firstWave = claims.flat();
      expect(firstWave).toHaveLength(1);
      const winner = firstWave[0]!;
      expect(
        await repository.markProcessed(
          winner.id,
          winner.lockedBy,
          winner.attempts,
          winner.leaseToken,
        ),
      ).toBe(true);
      expect(await workerB.claimInboundEvents("worker-b-next", 2)).toHaveLength(
        1,
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("dead-letters an exhausted event whose final lease expires", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const repository = createInboundEventsRepository(harness.db);
      const created = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "exhausted-item",
        payload: {},
        payloadDigest: "digest-exhausted",
        dedupeKey: "dedupe-exhausted",
      });
      const exhaustedPending = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "exhausted-pending-item",
        payload: {},
        payloadDigest: "digest-exhausted-pending",
        dedupeKey: "dedupe-exhausted-pending",
      });
      await harness.db.execute(sql`
        UPDATE inbound_webhook_events
        SET status = 'processing', attempts = 8, locked_by = 'dead-worker',
            lease_expires_at = now() - interval '1 second',
            lease_token = gen_random_uuid()::text
        WHERE id = ${created.id}
      `);
      await harness.db.execute(sql`
        UPDATE inbound_webhook_events SET attempts = 8
        WHERE id = ${exhaustedPending.id}
      `);

      await repository.claimInboundEvents("reaper-worker", 1);

      expect(await repository.findById(created.id)).toMatchObject({
        status: "dead",
        attempts: 8,
        lockedBy: null,
        leaseExpiresAt: null,
        lastErrorCode: "LEASE_EXPIRED",
      });
      expect(await repository.findById(exhaustedPending.id)).toMatchObject({
        status: "dead",
        attempts: 8,
        lastErrorCode: "ATTEMPTS_EXHAUSTED",
      });
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("does not let a newer same-item event bypass an older retry", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const repository = createInboundEventsRepository(harness.db);
      const older = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "ordered-item",
        payload: {},
        payloadDigest: "digest-older",
        dedupeKey: "dedupe-older",
        receivedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const newer = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "LOGIN_REPAIRED",
        providerItemId: "ordered-item",
        payload: {},
        payloadDigest: "digest-newer",
        dedupeKey: "dedupe-newer",
        receivedAt: new Date("2026-01-01T00:01:00Z"),
      });
      const first = await repository.claimInboundEvents("worker-a", 2);
      expect(first.map((row) => row.id)).toEqual([older.id]);
      expect(
        await repository.scheduleRetry(
          older.id,
          "worker-a",
          first[0]!.attempts,
          first[0]!.leaseToken,
          "UPSTREAM_FAILURE",
          new Date(),
          () => 0,
        ),
      ).toBe(true);

      expect(await repository.claimInboundEvents("worker-b", 2)).toEqual([]);
      await harness.db.execute(
        sql`UPDATE inbound_webhook_events SET status = 'processed', processed_at = now() WHERE id = ${older.id}`,
      );
      expect(
        (await repository.claimInboundEvents("worker-b", 2)).map(
          (row) => row.id,
        ),
      ).toEqual([newer.id]);
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("skips a locked exhausted row while claiming unrelated ready work", async () => {
    const harness = await createIsolatedTestDatabase();
    let releaseHolder: (() => void) | undefined;
    let holder: Promise<unknown> | undefined;
    try {
      const peerA = await harness.createPeerClient();
      const peerB = await harness.createPeerClient();
      const repository = createInboundEventsRepository(harness.db);
      const exhausted = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "locked-exhausted-item",
        payload: {},
        payloadDigest: "digest-locked-exhausted",
        dedupeKey: "dedupe-locked-exhausted",
      });
      const ready = await repository.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "ITEM",
        webhookCode: "ERROR",
        providerItemId: "unrelated-ready-item",
        payload: {},
        payloadDigest: "digest-unrelated-ready",
        dedupeKey: "dedupe-unrelated-ready",
      });
      await harness.db.execute(sql`
        UPDATE inbound_webhook_events
        SET status = 'processing', attempts = 8, locked_by = 'dead-worker',
            lease_expires_at = now() - interval '1 second',
            lease_token = gen_random_uuid()::text
        WHERE id = ${exhausted.id}
      `);
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      holder = peerA.client.begin(async (tx) => {
        await tx`UPDATE inbound_webhook_events SET locked_by = locked_by WHERE id = ${exhausted.id}`;
        locked();
        await new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
      });
      await lockReady;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const claimed = await Promise.race([
        createInboundEventsRepository(peerB.db).claimInboundEvents(
          "worker-b",
          1,
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("claim blocked by exhausted row")),
            2_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));

      expect(claimed.map((row) => row.id)).toEqual([ready.id]);
    } finally {
      releaseHolder?.();
      await holder;
      await harness.cleanup();
    }
  }, 120_000);
});
