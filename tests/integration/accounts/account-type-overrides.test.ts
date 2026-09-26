import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts, plaidItems, users } from "../../../database/schema/index.js";
import { createPlaidAccountWriter } from "../../../src/modules/accounts/index.js";
import { toAccountSummary } from "../../../src/modules/accounts/accounts.mapper.js";
import { createAccountRepository } from "../../../src/modules/accounts/accounts.repository.js";
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

guardedDescribe("checking/savings and rate overrides", () => {
  it("keep the user's choice through a Plaid sync and clear back to the bank's", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const [item] = await db
        .insert(plaidItems)
        .values({
          userId,
          plaidItemId: `plaid-${randomUUID()}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          accessTokenEncrypted: "e",
          accessTokenNonce: "n",
        })
        .returning();
      const plaidAccount = {
        account_id: "pa-1",
        name: "Everyday",
        type: "depository",
        subtype: "checking",
        mask: "0001",
        balances: { current: 1000, available: 1000, limit: null },
      };
      const writer = createPlaidAccountWriter(db);
      const created = await writer.upsertFromPlaid({
        userId,
        plaidItemUuid: item!.id,
        account: plaidAccount,
      });

      const repository = createAccountRepository(db);
      await repository.updateLinkedAccount(userId, created.id, {
        subtypeOverride: "savings",
        apyOverride: 4.25,
      });

      // The next sync reports the bank's values again.
      await writer.upsertFromPlaid({
        userId,
        plaidItemUuid: item!.id,
        account: {
          ...plaidAccount,
          balances: { ...plaidAccount.balances, current: 1100 },
        },
      });
      const load = async () => {
        const [row] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.id, created.id));
        return toAccountSummary({ ...row!, plaidItem: null });
      };
      const synced = await load();
      expect(synced.subtype).toBe("savings");
      expect(synced.apy).toBe(4.25);
      expect(synced.bank).toMatchObject({ subtype: "checking" });
      expect(synced.currentBalance).toBe("110000");

      await repository.updateLinkedAccount(userId, created.id, {
        subtypeOverride: null,
        apyOverride: null,
      });
      const cleared = await load();
      expect(cleared.subtype).toBe("checking");
      expect(cleared.apy).toBeNull();
      expect(cleared.overridden).toMatchObject({ subtype: false, apy: false });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
