import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  categories,
  userDataVersions,
  users,
} from "../../../database/schema/index.js";
import {
  createUserDataRepository,
  type UserDataRepository,
} from "../../../src/modules/user-data/user-data.repository.js";
import {
  BACKUP_VERSION,
  type BackupPayload,
} from "../../../src/modules/user-data/user-data.schemas.js";
import { createUserDataService } from "../../../src/modules/user-data/user-data.service.js";
import { createResponseCache } from "../../../src/platform/cache/response-cache.js";
import { createUserMutationService } from "../../../src/platform/cache/user-revisions.repository.js";
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

function backup(accountId: string): BackupPayload {
  return {
    version: BACKUP_VERSION,
    exportedAt: "2026-09-01T00:00:00.000Z",
    accounts: [
      {
        id: accountId,
        name: "Checking",
        officialName: null,
        mask: null,
        type: "depository",
        subtype: "checking",
        currency: "USD",
        currentBalance: "100",
        availableBalance: null,
        isHidden: false,
      },
    ],
    transactions: [],
    categories: [],
    rules: [],
    budgets: [],
    recurring: [],
  };
}

guardedDescribe("isolated user data repository", () => {
  it("binds every operation to the supplied database and rolls back imports", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userId = randomUUID();
    const accountId = randomUUID();
    try {
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "User Data",
      });
      const otherUserId = randomUUID();
      const otherCategoryId = randomUUID();
      await testDb.db.insert(users).values({
        id: otherUserId,
        email: `${otherUserId}@example.test`,
        name: "Other User",
      });
      await testDb.db.insert(categories).values({
        id: otherCategoryId,
        userId: otherUserId,
        name: "Other Category",
        parentId: null,
        isIncome: false,
        isTransfer: false,
        excludeFromBudgets: false,
        displayOrder: 0,
      });
      const repository: UserDataRepository = createUserDataRepository(
        testDb.db,
      );
      const systemCategoryId = randomUUID();
      await testDb.db.insert(categories).values({
        id: systemCategoryId,
        userId: null,
        name: "System",
        parentId: null,
        isIncome: false,
        isTransfer: false,
        excludeFromBudgets: false,
        displayOrder: 0,
      });
      const customCategoryId = randomUUID();
      const childPayload = {
        ...backup(accountId),
        categories: [
          {
            id: customCategoryId,
            parentId: systemCategoryId,
            name: "Custom",
            icon: null,
            color: null,
            isIncome: false,
            isTransfer: false,
            excludeFromBudgets: false,
            displayOrder: 1,
          },
        ],
      } satisfies BackupPayload;
      await repository.validateBackupReferences(userId, childPayload);
      await repository.importUserData(userId, childPayload);
      expect(
        await testDb.db
          .select()
          .from(categories)
          .where(eq(categories.id, customCategoryId)),
      ).toHaveLength(1);
      expect(
        await testDb.db
          .select()
          .from(accounts)
          .where(eq(accounts.userId, userId)),
      ).toHaveLength(1);

      const crossTenant = {
        ...backup(accountId),
        transactions: [
          {
            id: randomUUID(),
            accountId,
            plaidTransactionId: null,
            amount: "1",
            currency: "USD",
            date: "2026-09-01",
            name: "Cross tenant",
            merchantName: null,
            userName: null,
            categoryId: otherCategoryId,
            notes: null,
            status: "posted" as const,
            reviewStatus: "needs_review" as const,
            excludeFromBudgets: false,
            excludeFromReports: false,
            userCategoryOverride: false,
          },
        ],
      } satisfies BackupPayload;
      await expect(
        repository.validateBackupReferences(userId, crossTenant),
      ).rejects.toThrow(/another user/);

      const invalid = {
        ...backup(randomUUID()),
        transactions: [
          {
            id: randomUUID(),
            accountId: randomUUID(),
            plaidTransactionId: null,
            amount: "1",
            currency: "USD",
            date: "2026-09-01",
            name: "Invalid",
            merchantName: null,
            userName: null,
            categoryId: null,
            notes: null,
            status: "posted" as const,
            reviewStatus: "needs_review" as const,
            excludeFromBudgets: false,
            excludeFromReports: false,
            userCategoryOverride: false,
          },
        ],
      } satisfies BackupPayload;
      await expect(
        repository.validateBackupReferences(userId, invalid),
      ).rejects.toThrow();
      expect(
        await testDb.db
          .select()
          .from(accounts)
          .where(eq(accounts.userId, userId)),
      ).toHaveLength(1);

      const failing = {
        ...backup(randomUUID()),
        accounts: [
          { ...backup(randomUUID()).accounts[0]!, type: "not-a-db-enum" },
        ],
      } satisfies BackupPayload;
      await expect(
        repository.importUserData(userId, failing),
      ).rejects.toThrow();
      expect(
        await testDb.db
          .select()
          .from(accounts)
          .where(eq(accounts.userId, userId)),
      ).toHaveLength(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("keeps rows and revision unchanged on failure, and increments once per success", async () => {
    const testDb = await createIsolatedTestDatabase();
    const userId = randomUUID();
    const accountId = randomUUID();
    const cache = createResponseCache();
    const revocations: string[] = [];
    const mutation = createUserMutationService({
      db: testDb.db,
      cache,
      publishInvalidation: async () => undefined,
    });
    const repository = createUserDataRepository(testDb.db);
    const service = createUserDataService({
      repository,
      cache,
      withUserMutation: mutation.withUserMutation,
      revokePlaidItems: async (revokedUserId) => {
        revocations.push(revokedUserId);
      },
    });
    try {
      await testDb.db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        name: "Revision User",
      });
      await service.importUserData(userId, backup(accountId));
      expect(revocations).toEqual([userId]);
      const revisionAfterImport = await testDb.db
        .select({ revision: userDataVersions.revision })
        .from(userDataVersions)
        .where(eq(userDataVersions.userId, userId));
      expect(revisionAfterImport[0]?.revision).toBe(1n);
      expect(cache.stats().userInvalidations).toBe(1);

      const failing = {
        ...backup(randomUUID()),
        accounts: [{ ...backup(randomUUID()).accounts[0]!, type: "invalid" }],
      } satisfies BackupPayload;
      await expect(service.importUserData(userId, failing)).rejects.toThrow();
      expect(
        await testDb.db
          .select()
          .from(accounts)
          .where(eq(accounts.userId, userId)),
      ).toHaveLength(1);
      const unchanged = await testDb.db
        .select({ revision: userDataVersions.revision })
        .from(userDataVersions)
        .where(eq(userDataVersions.userId, userId));
      expect(unchanged[0]?.revision).toBe(1n);
      expect(cache.stats().userInvalidations).toBe(1);

      await service.resetUserData(userId);
      expect(revocations).toEqual([userId, userId]);
      const afterReset = await testDb.db
        .select({ revision: userDataVersions.revision })
        .from(userDataVersions)
        .where(eq(userDataVersions.userId, userId));
      expect(afterReset[0]?.revision).toBe(2n);
      expect(cache.stats().userInvalidations).toBe(2);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
