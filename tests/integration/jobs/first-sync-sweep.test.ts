import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { pipelineRuns, plaidItems, users } from "../../../database/schema/index.js";
import { createPipelineRepository } from "../../../src/modules/pipeline/pipeline.repository.js";
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

guardedDescribe("connections no run has picked up since linking", () => {
  it("lists only users whose never-synced connection was linked after their last run", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const at = (iso: string) => new Date(iso);
      const user = async () => {
        const id = randomUUID();
        await db.insert(users).values({ id, email: `${id}@example.test` });
        return id;
      };
      const item = (userId: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
        userId,
        plaidItemId: `plaid-${randomUUID()}`,
        institutionId: "ins_test",
        institutionName: "Chase",
        accessTokenEncrypted: "encrypted",
        accessTokenNonce: "nonce",
        createdAt: at(createdAt),
        ...extra,
      });
      const run = (userId: string, startedAt: string) => ({
        userId,
        trigger: "manual" as const,
        status: "success" as const,
        startedAt: at(startedAt),
      });

      // Chase on 2026-11-04: linked at 11:28 while the 11:26 run was going.
      const missed = await user();
      // Linked, then its own run queued.
      const pickedUp = await user();
      // Never synced, but a run has tried since: retries are that run's job.
      const tried = await user();
      // Linked under a minute ago: its own run may not be queued yet.
      const justLinked = await user();
      const synced = await user();
      const removed = await user();
      const relink = await user();

      await db.insert(plaidItems).values([
        item(missed, "2026-11-04T11:26:07Z", { cursor: "c" }),
        item(missed, "2026-11-04T11:28:08Z"),
        item(pickedUp, "2026-11-04T11:28:08Z"),
        item(tried, "2026-11-04T11:00:00Z"),
        item(justLinked, "2026-11-04T11:29:30Z"),
        item(synced, "2026-11-04T11:00:00Z", { cursor: "c" }),
        item(removed, "2026-11-04T11:00:00Z", { deletedAt: at("2026-11-04T11:10:00Z") }),
        item(relink, "2026-11-04T11:00:00Z", { status: "login_required" }),
      ]);
      await db.insert(pipelineRuns).values([
        run(missed, "2026-11-04T11:26:09Z"),
        run(pickedUp, "2026-11-04T11:28:09Z"),
        run(tried, "2026-11-04T11:00:05Z"),
      ]);

      const awaiting = await createPipelineRepository(db).listUsersAwaitingFirstSync(
        at("2026-11-04T11:29:00Z"),
      );
      expect(awaiting).toEqual([missed]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
