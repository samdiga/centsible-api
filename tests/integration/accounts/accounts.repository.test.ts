import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  auditLog,
  plaidItems,
  transactions,
  userDataVersions,
  users,
} from "../../../database/schema/index.js";
import { createResponseCache } from "../../../src/platform/cache/response-cache.js";
import { createWithUserMutation } from "../../../src/platform/cache/user-revisions.repository.js";
import { createAccountRepository } from "../../../src/modules/accounts/accounts.repository.js";
import { createAccountService } from "../../../src/modules/accounts/accounts.service.js";
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

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected inserted row");
  return value;
}

async function setup(
  db: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"],
) {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Account Test User",
  });
  const item = present(
    (
      await db
        .insert(plaidItems)
        .values({
          userId,
          plaidItemId: `plaid-${randomUUID()}`,
          institutionId: "ins",
          institutionName: "Bank",
          accessTokenEncrypted: "e",
          accessTokenNonce: "n",
        })
        .returning()
    )[0],
  );
  return { userId, item };
}

const plaidAccount = (id: string) => ({
  account_id: id,
  name: "Checking",
  type: "depository",
  subtype: "checking",
  mask: "1234",
  balances: { current: 100.005, available: null, iso_currency_code: "USD" },
});

guardedDescribe("isolated account repository", () => {
  it("preserves transactions, same-item removal, and different-item relinking", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { userId, item } = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const before = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-history"),
      });
      await testDb.db.insert(transactions).values({
        userId,
        accountId: before.id,
        plaidTransactionId: `txn-${randomUUID()}`,
        name: "Coffee",
        amount: 500n,
        date: "2026-09-01",
      });
      expect(await repository.softDelete(userId, before.id)).toMatchObject({
        id: before.id,
      });
      expect(await repository.softDelete(userId, before.id)).toBeNull();
      await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-history"),
      });
      expect(await repository.listByUser(userId)).toHaveLength(0);
      const newItem = present(
        (
          await testDb.db
            .insert(plaidItems)
            .values({
              userId,
              plaidItemId: `plaid-${randomUUID()}`,
              institutionId: "ins",
              institutionName: "Bank",
              accessTokenEncrypted: "e",
              accessTokenNonce: "n",
            })
            .returning()
        )[0],
      );
      const relinked = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: newItem.id,
        account: plaidAccount("account-history"),
      });
      expect(relinked.id).toBe(before.id);
      expect(
        await testDb.db
          .select()
          .from(transactions)
          .where(eq(transactions.accountId, before.id)),
      ).toHaveLength(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("enforces tenant ownership for reads, writes, and upsert targets", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const owner = await setup(testDb.db);
      const other = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const account = await repository.upsertFromPlaid({
        userId: owner.userId,
        plaidItemUuid: owner.item.id,
        account: plaidAccount("account-private"),
      });
      expect(await repository.findById(other.userId, account.id)).toBeNull();
      expect(await repository.softDelete(other.userId, account.id)).toBeNull();
      await expect(
        repository.upsertFromPlaid({
          userId: other.userId,
          plaidItemUuid: other.item.id,
          account: plaidAccount("account-private"),
        }),
      ).rejects.toThrow();
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("makes concurrent account deletes produce one last-live unlink decision", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { userId, item } = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const first = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-concurrent-1"),
      });
      const second = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-concurrent-2"),
      });
      const cache = createResponseCache();
      const mutation = createWithUserMutation({
        db: testDb.db,
        cache,
        publishInvalidation: async () => undefined,
      });
      let unlinkCalls = 0;
      const service = createAccountService({
        repository,
        cache,
        withUserMutation: mutation,
        unlinkActiveItem: {
          unlinkActiveItem: async () => {
            unlinkCalls += 1;
            return true;
          },
        },
      });
      const results = await Promise.all([
        service.removeAccount(userId, first.id),
        service.removeAccount(userId, second.id),
      ]);
      expect(results.filter((result) => result.unlinkedItem)).toHaveLength(1);
      expect(unlinkCalls).toBe(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("commits delete, audit, revision, and cache eviction atomically", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { userId, item } = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const account = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-audit"),
      });
      const cache = createResponseCache();
      const service = createAccountService({
        repository,
        cache,
        withUserMutation: createWithUserMutation({
          db: testDb.db,
          cache,
          publishInvalidation: async () => undefined,
        }),
      });
      await service.listAccountSummaries(userId);
      await expect(service.removeAccount(userId, account.id)).resolves.toEqual({
        removed: true,
        unlinkedItem: false,
      });
      expect(
        await testDb.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.entityId, account.id)),
      ).toHaveLength(1);
      expect(
        (
          await testDb.db
            .select()
            .from(userDataVersions)
            .where(eq(userDataVersions.userId, userId))
        )[0]?.revision,
      ).toBe(1n);
      expect(cache.stats().userInvalidations).toBe(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("rolls back account deletion and revision when audit insertion fails", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { userId, item } = await setup(testDb.db);
      const base = createAccountRepository(testDb.db);
      const account = await base.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-audit-failure"),
      });
      const repository = {
        ...base,
        recordAudit: async () => {
          throw new Error("audit failed");
        },
      };
      const cache = createResponseCache();
      const service = createAccountService({
        repository,
        cache,
        withUserMutation: createWithUserMutation({
          db: testDb.db,
          cache,
          publishInvalidation: async () => undefined,
        }),
      });
      await expect(service.removeAccount(userId, account.id)).rejects.toThrow(
        "audit failed",
      );
      expect(
        (
          await testDb.db
            .select()
            .from(accounts)
            .where(eq(accounts.id, account.id))
        )[0]?.deletedAt,
      ).toBeNull();
      expect(
        await testDb.db
          .select()
          .from(userDataVersions)
          .where(eq(userDataVersions.userId, userId)),
      ).toHaveLength(0);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("does not unlink when an account points at a foreign item", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const owner = await setup(testDb.db);
      const foreign = await setup(testDb.db);
      const base = createAccountRepository(testDb.db);
      const account = await base.upsertFromPlaid({
        userId: owner.userId,
        plaidItemUuid: owner.item.id,
        account: plaidAccount("account-corrupt-link"),
      });
      await testDb.db
        .update(accounts)
        .set({ plaidItemId: foreign.item.id })
        .where(eq(accounts.id, account.id));
      const cache = createResponseCache();
      let unlinkCalls = 0;
      const service = createAccountService({
        repository: base,
        cache,
        withUserMutation: createWithUserMutation({
          db: testDb.db,
          cache,
          publishInvalidation: async () => undefined,
        }),
        unlinkActiveItem: {
          unlinkActiveItem: async () => {
            unlinkCalls += 1;
            return true;
          },
        },
      });
      await expect(
        service.removeAccount(owner.userId, account.id),
      ).resolves.toEqual({ removed: true, unlinkedItem: false });
      expect(unlinkCalls).toBe(0);
      expect(
        (
          await testDb.db
            .select()
            .from(accounts)
            .where(eq(accounts.id, account.id))
        )[0]?.deletedAt,
      ).toEqual(expect.any(Date));
      const missing = await base.upsertFromPlaid({
        userId: owner.userId,
        plaidItemUuid: owner.item.id,
        account: plaidAccount("account-missing-link"),
      });
      await testDb.db
        .update(accounts)
        .set({ plaidItemId: null })
        .where(eq(accounts.id, missing.id));
      await expect(
        service.removeAccount(owner.userId, missing.id),
      ).resolves.toEqual({ removed: true, unlinkedItem: false });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("treats wrong-user and repeated deletion as no-ops", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const owner = await setup(testDb.db);
      const other = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const account = await repository.upsertFromPlaid({
        userId: owner.userId,
        plaidItemUuid: owner.item.id,
        account: plaidAccount("account-repeat"),
      });
      const cache = createResponseCache();
      const service = createAccountService({
        repository,
        cache,
        withUserMutation: createWithUserMutation({
          db: testDb.db,
          cache,
          publishInvalidation: async () => undefined,
        }),
      });
      await expect(
        service.removeAccount(other.userId, account.id),
      ).resolves.toEqual({ removed: false, unlinkedItem: false });
      await expect(
        service.removeAccount(owner.userId, account.id),
      ).resolves.toEqual({ removed: true, unlinkedItem: false });
      await expect(
        service.removeAccount(owner.userId, account.id),
      ).resolves.toEqual({ removed: false, unlinkedItem: false });
      expect(
        await testDb.db
          .select()
          .from(userDataVersions)
          .where(eq(userDataVersions.userId, other.userId)),
      ).toHaveLength(0);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("reconciles concurrent global plaid account conflicts without a raw unique error", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const owner = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const [first, second] = await Promise.all([
        repository.upsertFromPlaid({
          userId: owner.userId,
          plaidItemUuid: owner.item.id,
          account: plaidAccount("account-race"),
        }),
        repository.upsertFromPlaid({
          userId: owner.userId,
          plaidItemUuid: owner.item.id,
          account: plaidAccount("account-race"),
        }),
      ]);
      expect(first.id).toBe(second.id);
      await expect(
        repository.findByPlaidAccountId("account-race", owner.userId),
      ).resolves.toMatchObject({ id: first.id });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
