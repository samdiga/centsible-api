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

guardedDescribe("Bank last updated per connection", () => {
  it("stores, replaces and clears only that connection's value", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const me = randomUUID();
      await db.insert(users).values({ id: me, email: `${me}@example.test` });
      const item = (name: string) => ({
        userId: me,
        plaidItemId: `plaid-${randomUUID()}`,
        institutionId: "ins_test",
        institutionName: name,
        accessTokenEncrypted: "encrypted",
        accessTokenNonce: "nonce",
      });
      const [macys, other] = await db
        .insert(plaidItems)
        .values([item("Macy's"), item("Other")])
        .returning();
      expect(macys!.bankLastUpdatedAt).toBeNull();

      const repository = createPlaidItemsRepository(db);
      const read = async (id: string) =>
        (await db.select().from(plaidItems).where(eq(plaidItems.id, id)))[0]!
          .bankLastUpdatedAt;

      await repository.markBankUpdated(macys!.id, new Date("2026-10-15T04:56:23.821Z"));
      expect((await read(macys!.id))?.toISOString()).toBe("2026-10-15T04:56:23.821Z");
      expect(await read(other!.id)).toBeNull();

      await repository.markBankUpdated(macys!.id, new Date("2026-10-30T01:00:00.000Z"));
      expect((await read(macys!.id))?.toISOString()).toBe("2026-10-30T01:00:00.000Z");

      await repository.markBankUpdated(macys!.id, null);
      expect(await read(macys!.id)).toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
