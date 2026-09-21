import { and, count, isNull, isNotNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { seedSchema } from "../../../database/seed.js";
import { categories } from "../../../database/schema/index.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

const guardedDescribe = hasExternalTestDatabaseApproval()
  ? describe
  : describe.skip;

guardedDescribe("system data seed", () => {
  it("creates the complete category hierarchy once", async () => {
    const testDb = await createIsolatedTestDatabase();

    try {
      const peer = await testDb.createPeerClient();
      await seedSchema(peer.client, testDb.schemaName);
      await seedSchema(peer.client, testDb.schemaName);

      const [rootCount] = await testDb.db
        .select({ value: count() })
        .from(categories)
        .where(and(isNull(categories.userId), isNull(categories.parentId)));
      const [childCount] = await testDb.db
        .select({ value: count() })
        .from(categories)
        .where(and(isNull(categories.userId), isNotNull(categories.parentId)));
      const roots = await testDb.db
        .select({
          name: categories.name,
          isIncome: categories.isIncome,
          isTransfer: categories.isTransfer,
          excludeFromBudgets: categories.excludeFromBudgets,
        })
        .from(categories)
        .where(
          and(
            isNull(categories.userId),
            isNull(categories.parentId),
            isNull(categories.archivedAt),
          ),
        );

      expect(rootCount?.value).toBe(22);
      expect(childCount?.value).toBe(89);
      expect(roots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Income", isIncome: true }),
          expect.objectContaining({
            name: "Transfer",
            isTransfer: true,
            excludeFromBudgets: true,
          }),
          expect.objectContaining({ name: "Uncategorized" }),
        ]),
      );
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
