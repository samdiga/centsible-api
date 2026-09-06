import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  auditLog,
  transactions,
  users,
} from "../../../database/schema/index.js";
import { createResponseCache } from "../../../src/platform/cache/response-cache.js";
import { createWithUserMutation } from "../../../src/platform/cache/user-revisions.repository.js";
import { createTransactionService } from "../../../src/modules/transactions/transactions.service.js";
import { createTransactionRepository } from "../../../src/modules/transactions/transactions.repository.js";
import { ForbiddenError } from "../../../src/platform/errors/app-error.js";
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
  it("commits a PATCH together with a JSON-safe audit snapshot", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const accountId = randomUUID();
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "Transaction Audit User",
      });
      await testDb.db.insert(accounts).values({
        id: accountId,
        userId,
        plaidAccountId: `plaid-${randomUUID()}`,
        name: "Checking",
        type: "depository",
        subtype: "checking",
      });
      const repository = createTransactionRepository(testDb.db);
      const transaction = await repository.upsertFromPlaid({
        userId,
        accountId,
        txn: {
          transaction_id: `transaction-${randomUUID()}`,
          amount: 12.5,
          date: "2026-09-04",
          pending: false,
          name: "Coffee",
        },
      });
      const cache = createResponseCache();
      const service = createTransactionService({
        repository,
        cache,
        withUserMutation: createWithUserMutation({
          db: testDb.db,
          cache,
          publishInvalidation: async () => undefined,
        }),
      });

      await expect(
        service.patchTransaction(userId, transaction.id, {
          notes: "Updated note",
        }),
      ).resolves.toMatchObject({ notes: "Updated note" });

      const audits = await testDb.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, transaction.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        entityType: "transaction",
        source: "transactions.patch",
        beforeJson: expect.objectContaining({ amount: "1250" }),
        afterJson: expect.objectContaining({
          amount: "1250",
          notes: "Updated note",
        }),
      });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

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

  it("isolates tenant reads and refuses foreign writes while preserving Plaid override semantics", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const userId = randomUUID();
      const otherUserId = randomUUID();
      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      await testDb.db.insert(users).values([
        { id: userId, email: `${userId}@example.test`, name: "Owner" },
        {
          id: otherUserId,
          email: `${otherUserId}@example.test`,
          name: "Other",
        },
      ]);
      await testDb.db.insert(accounts).values([
        {
          id: accountId,
          userId,
          plaidAccountId: `plaid-${randomUUID()}`,
          name: "Owner checking",
          type: "depository",
          subtype: "checking",
        },
        {
          id: otherAccountId,
          userId: otherUserId,
          plaidAccountId: `plaid-${randomUUID()}`,
          name: "Other checking",
          type: "depository",
          subtype: "checking",
        },
      ]);
      const repository = createTransactionRepository(testDb.db);
      const owner = await repository.upsertFromPlaid({
        userId,
        accountId,
        txn: {
          transaction_id: `owner-${randomUUID()}`,
          amount: 12.5,
          date: "2026-09-04",
          pending: false,
          name: "Coffee",
          personal_finance_category: {
            primary: "FOOD_AND_DRINK",
            detailed: "FOOD_AND_DRINK_COFFEE",
            confidence_level: "HIGH",
          },
        },
      });
      const foreign = await repository.upsertFromPlaid({
        userId: otherUserId,
        accountId: otherAccountId,
        txn: {
          transaction_id: `other-${randomUUID()}`,
          amount: 5,
          date: "2026-09-04",
          pending: false,
          name: "Other coffee",
        },
      });
      await repository.updateTransaction(owner.id, userId, {
        categoryId: null,
      });
      const resynced = await repository.upsertFromPlaid({
        userId,
        accountId,
        txn: {
          transaction_id: owner.plaidTransactionId!,
          amount: 12.5,
          date: "2026-09-04",
          pending: false,
          name: "Coffee",
          personal_finance_category: {
            primary: "TRANSPORTATION",
            detailed: "TRANSPORTATION_TAXI",
            confidence_level: "HIGH",
          },
        },
      });

      expect(resynced.id).toBe(owner.id);
      expect(resynced.userCategoryOverride).toBe(true);
      expect(resynced.plaidCategoryPrimary).toBe("FOOD_AND_DRINK");
      expect(
        (
          await repository.listByUser({ userId, limit: 10, filters: {} })
        ).rows.map((row) => row.id),
      ).toEqual([owner.id]);
      expect(await repository.findById(foreign.id, userId)).toBeNull();
      expect(
        await repository.updateTransaction(foreign.id, userId, {
          notes: "blocked",
        }),
      ).toBeNull();
      await expect(
        repository.bulkUpdateTransactions([owner.id, foreign.id], userId, {
          reviewStatus: "reviewed",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await repository.softDeleteByPlaidIds(
        [owner.plaidTransactionId!],
        userId,
      );
      expect(await repository.findById(owner.id, userId)).toBeNull();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
