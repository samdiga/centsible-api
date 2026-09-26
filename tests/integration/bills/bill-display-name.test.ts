import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { billSetup, users } from "../../../database/schema/index.js";
import { toBillDto } from "../../../src/modules/bills/bills.mapper.js";
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

guardedDescribe("bill display name", () => {
  it("survives re-detection without creating a duplicate, and clears back to the detected name", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { db } = testDb;
      const repository = createBillsRepository(db);
      const userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: "U" });
      const detected = {
        canonicalName: "city power co",
        cadence: "monthly" as const,
        avgAmountCents: 8000n,
        stdDevAmountCents: 0n,
        lastAmountCents: 8000n,
        lastOccurredOn: "2026-09-01",
        nextExpectedDate: "2026-10-01",
        confidence: 0.9,
        sampleCount: 3,
        status: "pending_confirmation" as const,
        isIncome: false,
      };
      await repository.upsertDetected(userId, [detected]);
      const [row] = await db
        .select()
        .from(billSetup)
        .where(eq(billSetup.userId, userId));

      const renamed = await repository.update(userId, row!.id, {
        displayName: "Electricity",
      });
      expect(toBillDto(renamed!)).toMatchObject({
        name: "Electricity",
        displayName: "Electricity",
        canonicalName: "city power co",
      });

      // The next detection run matches on canonical_name: no second bill,
      // and the user's name is kept.
      await repository.upsertDetected(userId, [
        { ...detected, lastOccurredOn: "2026-10-01" },
      ]);
      const rows = await db
        .select()
        .from(billSetup)
        .where(eq(billSetup.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.displayName).toBe("Electricity");

      const cleared = await repository.update(userId, row!.id, {
        displayName: null,
      });
      expect(toBillDto(cleared!).name).toBe("city power co");
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
