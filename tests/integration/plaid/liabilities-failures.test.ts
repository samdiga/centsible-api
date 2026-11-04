import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { plaidItems, users } from "../../../database/schema/index.js";
import { createPlaidItemsRepository } from "../../../src/modules/plaid/plaid-items.repository.js";
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

guardedDescribe("Failed Liabilities fetches per connection", () => {
  it("counts a run of failures, clears only a stale re-approve, and resets on a recorded status", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const me = randomUUID();
      await db.insert(users).values({ id: me, email: `${me}@example.test` });
      const item = (
        name: string,
        liabilitiesStatus: "available" | "consent_required" | null,
      ) => ({
        userId: me,
        plaidItemId: `plaid-${randomUUID()}`,
        institutionId: "ins_test",
        institutionName: name,
        accessTokenEncrypted: "encrypted",
        accessTokenNonce: "nonce",
        liabilitiesStatus,
      });
      const [macys, other] = await db
        .insert(plaidItems)
        .values([item("Macy's", "consent_required"), item("Other", "available")])
        .returning();
      expect(macys!.liabilitiesFailures).toBe(0);

      const repository = createPlaidItemsRepository(db);
      const read = async (id: string) => {
        const [row] = await db
          .select()
          .from(plaidItems)
          .where(eq(plaidItems.id, id));
        return [row!.liabilitiesStatus, row!.liabilitiesFailures];
      };

      await repository.recordLiabilitiesFailure(macys!.id, me, { clearConsent: false });
      expect(await read(macys!.id)).toEqual(["consent_required", 1]);

      await repository.recordLiabilitiesFailure(macys!.id, me, { clearConsent: true });
      expect(await read(macys!.id)).toEqual([null, 2]);

      // Clearing never touches a status other than consent_required.
      await repository.recordLiabilitiesFailure(other!.id, me, { clearConsent: true });
      expect(await read(other!.id)).toEqual(["available", 1]);

      // Another user's id matches nothing.
      await repository.recordLiabilitiesFailure(macys!.id, randomUUID(), { clearConsent: false });
      expect(await read(macys!.id)).toEqual([null, 2]);

      // Same status as recorded still ends the run of failures.
      await repository.setLiabilitiesStatus(other!.id, me, "available");
      expect(await read(other!.id)).toEqual(["available", 0]);
      await repository.setLiabilitiesStatus(macys!.id, me, "not_supported");
      expect(await read(macys!.id)).toEqual(["not_supported", 0]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
