import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accounts, billSetup, users } from "../../../database/schema/index.js";
import { createDashboardRepository } from "../../../src/modules/dashboard/dashboard.repository.js";
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

guardedDescribe("dashboard repository", () => {
  it("returns only live user accounts and confirmed upcoming payable bills", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
      });
      await testDb.db.insert(accounts).values({
        id: randomUUID(),
        userId,
        name: "Checking",
        type: "depository",
        subtype: "checking",
        currentBalance: 300000n,
        availableBalance: 290000n,
      });
      const today = new Date().toISOString().slice(0, 10);
      await testDb.db.insert(billSetup).values({
        userId,
        canonicalName: "Rent",
        cadence: "monthly",
        avgAmount: 150000n,
        nextExpectedDate: today,
        status: "active",
        userConfirmed: true,
      });
      await testDb.db.insert(billSetup).values({
        userId,
        canonicalName: "Unconfirmed",
        cadence: "monthly",
        avgAmount: 100n,
        nextExpectedDate: today,
        status: "active",
        userConfirmed: false,
      });

      const repository = createDashboardRepository(testDb.db);
      await expect(repository.listAccounts(userId)).resolves.toEqual([
        expect.objectContaining({
          type: "depository",
          currentBalance: 300000n,
          availableBalance: 290000n,
        }),
      ]);
      await expect(repository.getUpcomingBills(userId)).resolves.toEqual([
        expect.objectContaining({ canonicalName: "Rent", avgAmount: 150000n }),
      ]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
