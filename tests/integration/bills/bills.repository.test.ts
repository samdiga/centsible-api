import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  billOccurrences,
  billSetup,
  users,
} from "../../../database/schema/index.js";
import { createBillOccurrencesRepository } from "../../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../../src/modules/bills/bills.repository.js";
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

guardedDescribe("bills repositories", () => {
  it("lists setup occurrence history oldest first and atomically rejects a second terminal transition", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      await testDb.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` });
      const [bill] = await testDb.db
        .insert(billSetup)
        .values({
          userId,
          canonicalName: "Rent",
          cadence: "monthly",
          avgAmount: 100n,
          nextExpectedDate: "2026-10-01",
          status: "active",
          userConfirmed: true,
        })
        .returning();
      await testDb.db.insert(billOccurrences).values([
        {
          userId,
          billSetupId: bill!.id,
          dueDate: "2026-09-01",
          expectedAmountCents: 100n,
        },
        {
          userId,
          billSetupId: bill!.id,
          dueDate: "2026-10-01",
          expectedAmountCents: 100n,
        },
      ]);
      const occurrences = createBillOccurrencesRepository(testDb.db);
      const history = await occurrences.listBySetup(userId, bill!.id);
      expect(history.map((row) => row.dueDate)).toEqual([
        "2026-09-01",
        "2026-10-01",
      ]);
      expect(
        await occurrences.updateIfStatus(userId, history[0]!.id, ["upcoming"], {
          status: "skipped",
        }),
      ).not.toBeNull();
      await expect(
        occurrences.updateIfStatus(userId, history[0]!.id, ["upcoming"], {
          status: "processing",
        }),
      ).resolves.toBeNull();
      await expect(
        createBillsRepository(testDb.db).findById(userId, bill!.id),
      ).resolves.toMatchObject({ id: bill!.id });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
