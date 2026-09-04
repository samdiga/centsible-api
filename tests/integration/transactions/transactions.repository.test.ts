import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accounts,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
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

guardedDescribe("isolated transactions repository", () => {
  it("uses tenant-scoped opaque keyset pages without repeating transactions", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const accountId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "Transaction Test User",
      });
      await testDb.db.insert(accounts).values({
        id: accountId,
        userId,
        plaidAccountId: `plaid-${randomUUID()}`,
        name: "Checking",
        type: "depository",
        subtype: "checking",
      });
      await testDb.db.insert(transactions).values(
        [0, 1, 2, 3].map((index) => ({
          userId,
          accountId,
          plaidTransactionId: `transaction-${randomUUID()}`,
          name: `Transaction ${index}`,
          amount: 100n,
          date: `2026-09-0${4 - index}`,
        })),
      );
      const repository = createTransactionRepository(testDb.db);

      const firstPage = await repository.listByUser({
        userId,
        limit: 2,
        filters: {},
      });
      const secondPage = await repository.listByUser({
        userId,
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
        filters: {},
      });

      expect(firstPage.rows).toHaveLength(2);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      expect(
        new Set([...firstPage.rows, ...secondPage.rows].map((row) => row.id))
          .size,
      ).toBe(4);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
