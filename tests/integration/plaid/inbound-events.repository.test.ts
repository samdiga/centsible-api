import { randomUUID } from "node:crypto";
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
  it("claims one durable delivery across concurrent workers and supports dead replay", async () => {
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
        payloadDigest: "digest",
        dedupeKey: "dedupe",
      });
      const [first, second] = await Promise.all([
        repository.claimInboundEvents("worker-a", 1),
        repository.claimInboundEvents("worker-b", 1),
      ]);
      const claimed = [...first, ...second];
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(created.id);
      expect(
        await repository.markDead(
          created.id,
          claimed[0]!.lockedBy,
          "provider failure",
        ),
      ).toBe(true);
      expect(await repository.replayDeadEvent(created.id)).toMatchObject({
        id: created.id,
        status: "pending",
        attempts: 0,
      });
      expect(await repository.claimInboundEvents("worker-c", 1)).toHaveLength(
        1,
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);
});
