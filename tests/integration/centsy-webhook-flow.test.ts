import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  auditLog,
  pipelineRuns,
  plaidItems,
  users,
} from "../../database/schema/index.js";
import { createInboundEventHandler } from "../../src/modules/plaid/inbound-event-handler.js";
import { createInboundEventsPoller } from "../../src/modules/plaid/inbound-events-poller.js";
import { createInboundEventsRepository } from "../../src/modules/plaid/inbound-events.repository.js";
import { createPlaidItemsRepository } from "../../src/modules/plaid/plaid-items.repository.js";
import { createPipelineRepository } from "../../src/modules/pipeline/pipeline.repository.js";
import { createPipelineService } from "../../src/modules/pipeline/pipeline.service.js";
import { createAuditLogRepository } from "../../src/platform/database/audit-log.repository.js";
import {
  createUserInvalidationListener,
  createWithUserMutation,
  getUserRevision,
  publishUserInvalidation,
  type UserInvalidationListener,
} from "../../src/platform/cache/user-revisions.repository.js";
import { createResponseCache } from "../../src/platform/cache/response-cache.js";
import {
  insertFixtureFromCentsy,
  validItemErrorWebhook,
  validSyncWebhook,
} from "../contract/centsy-webhook-fixtures.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../support/test-database.js";
import { runCleanupActions } from "../support/cleanup.js";

const guardedDescribe = (() => {
  try {
    readTestDatabaseConfig(process.env);
    return describe;
  } catch {
    return describe.skip;
  }
})();

guardedDescribe("Centsy webhook handoff", () => {
  it("consumes Centsy's raw rows once, creates a webhook run, and invalidates a status mutation", async () => {
    const harness = await createIsolatedTestDatabase();
    const userId = randomUUID();
    let invalidationListener: UserInvalidationListener | undefined;

    try {
      await harness.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "Centsy Contract",
      });
      await harness.db.insert(plaidItems).values({
        userId,
        plaidItemId: "item-centsy-contract",
        institutionId: "ins_centsy_contract",
        institutionName: "Centsy Contract Bank",
        accessTokenEncrypted: "encrypted",
        accessTokenNonce: "nonce",
      });

      const repository = createInboundEventsRepository(harness.db);
      const listenerPeer = await harness.createPeerClient();
      const responseCache = createResponseCache();
      invalidationListener = createUserInvalidationListener({
        cache: responseCache,
        listen: async (channel, onNotification) => {
          const subscription = await listenerPeer.client.listen(
            channel,
            onNotification,
          );
          return { unlisten: () => subscription.unlisten() };
        },
      });
      await invalidationListener.start();
      const pipeline = createPipelineService({
        db: harness.db,
        repository: createPipelineRepository(harness.db),
      });
      const handler = createInboundEventHandler({
        items: createPlaidItemsRepository(harness.db),
        startPipeline: pipeline.startPipelineRun,
        withUserMutation: createWithUserMutation({
          db: harness.db,
          // The worker has no local response cache; its post-commit NOTIFY is
          // consumed by the independently connected API listener above.
          cache: { invalidateUser: () => undefined },
          publishInvalidation: (id) => publishUserInvalidation(id, harness.db),
        }),
        audit: createAuditLogRepository(harness.db),
      });
      const poller = createInboundEventsPoller({
        workerId: "centsy-contract-worker",
        repository,
        handler,
        concurrency: 4,
        logger: { error: () => undefined },
      });

      const inserted = await insertFixtureFromCentsy(harness.db, {
        ...validSyncWebhook,
        id: randomUUID(),
      });
      const duplicate = await insertFixtureFromCentsy(harness.db, {
        ...validSyncWebhook,
        id: randomUUID(),
      });
      await poller.pollOnce();

      await expect(repository.findById(inserted.id)).resolves.toMatchObject({
        id: inserted.id,
        status: "processed",
        attempts: 1,
        provider: "plaid",
        webhookType: "TRANSACTIONS",
        webhookCode: "SYNC_UPDATES_AVAILABLE",
        payloadDigest: "a".repeat(64),
        dedupeKey: "b".repeat(64),
      });
      await expect(repository.findById(duplicate.id)).resolves.toMatchObject({
        id: duplicate.id,
        status: "processed",
        attempts: 1,
      });
      const webhookRuns = await harness.db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.userId, userId));
      expect(webhookRuns).toHaveLength(1);
      expect(webhookRuns[0]).toMatchObject({
        trigger: "webhook",
        status: "running",
      });

      const revisionBefore = await getUserRevision(userId, harness.db);
      const cacheKey = {
        userId,
        method: "GET" as const,
        route: "/plaid/items",
        query: {},
        revision: revisionBefore,
      };
      await responseCache.getOrCompute(cacheKey, async () => ({ stale: true }));
      expect(responseCache.stats().entries).toBe(1);
      const statusEvent = await insertFixtureFromCentsy(harness.db, {
        ...validItemErrorWebhook,
        id: randomUUID(),
      });
      await poller.pollOnce();

      await expect(repository.findById(statusEvent.id)).resolves.toMatchObject({
        id: statusEvent.id,
        status: "processed",
        attempts: 1,
      });
      expect(await getUserRevision(userId, harness.db)).toBeGreaterThan(
        revisionBefore,
      );
      await vi.waitFor(
        () => {
          expect(responseCache.stats()).toMatchObject({
            entries: 0,
            userInvalidations: 1,
            userEntriesInvalidated: 1,
          });
        },
        { interval: 10, timeout: 5_000 },
      );
      let recomputations = 0;
      await responseCache.getOrCompute(cacheKey, async () => {
        recomputations += 1;
        return { stale: false };
      });
      expect(recomputations).toBe(1);
      const item = await harness.db
        .select()
        .from(plaidItems)
        .where(eq(plaidItems.plaidItemId, "item-centsy-contract"));
      expect(item[0]).toMatchObject({
        status: "login_required",
        errorCode: "ITEM_LOGIN_REQUIRED",
      });
      const audits = await harness.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, userId));
      expect(audits).toHaveLength(1);
    } finally {
      await runCleanupActions(
        [async () => invalidationListener?.stop(), () => harness.cleanup()],
        "Centsy webhook handoff cleanup failed",
      );
    }
  }, 120_000);
});
