import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createInboundEventsRepository } from "../../../src/modules/plaid/inbound-events.repository.js";
import { createJobsRepository } from "../../../src/platform/jobs/jobs.repository.js";
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

guardedDescribe("next wake-up time", () => {
  it("returns a real Date for a pending future job and inbound event", async () => {
    const harness = await createIsolatedTestDatabase();
    try {
      const jobs = createJobsRepository({ db: harness.db });
      const inbound = createInboundEventsRepository(harness.db);
      expect(await jobs.nextAvailableAt()).toBeNull();
      expect(await inbound.nextAvailableAt()).toBeNull();

      const at = new Date(Date.now() + 3 * 3_600_000);
      at.setMilliseconds(0);
      await jobs.enqueueJob({
        type: "bill_reminders",
        payload: { userId: randomUUID(), localDate: "2026-10-01" },
        scheduledFor: at,
      });
      const event = await inbound.insert({
        id: randomUUID(),
        provider: "plaid",
        webhookType: "TRANSACTIONS",
        webhookCode: "SYNC_UPDATES_AVAILABLE",
        providerItemId: "item",
        payload: {},
        payloadDigest: "digest",
        dedupeKey: "dedupe",
      });
      await harness.db.execute(
        sql`UPDATE inbound_webhook_events SET available_at = ${at.toISOString()}::timestamptz WHERE id = ${event.id}`,
      );

      for (const next of [
        await jobs.nextAvailableAt(),
        await inbound.nextAvailableAt(),
      ]) {
        expect(next).toBeInstanceOf(Date);
        expect(next?.getTime()).toBe(at.getTime());
      }
    } finally {
      await harness.cleanup();
    }
  }, 60_000);
});
