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
import { createPlaidAccountWriter } from "../../../src/modules/accounts/index.js";
import {
  createIsolatedTestDatabase,
  getTransactionBackendPid,
  readTestDatabaseConfig,
  waitForBlockedBackend,
} from "../../support/test-database.js";
import type { IsolatedSchemaClient } from "../../support/test-database.js";

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

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) throw new Error("deferred promise is not ready");
      resolvePromise(value);
    },
  };
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
    let peer: IsolatedSchemaClient | undefined;
    let observer: IsolatedSchemaClient | undefined;
    try {
      peer = await testDb.createPeerClient();
      observer = await testDb.createPeerClient();
      const peerClient = peer;
      const observerClient = observer;
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
      let unlinkCalls = 0;
      const holderReady = deferred<void>();
      const releaseHolder = deferred<void>();
      let holderPid: number | undefined;
      const holderRepository = {
        ...repository,
        lockItem: async (
          accountUserId: string,
          itemId: string,
          tx: Parameters<typeof repository.lockItem>[2],
        ) => {
          await repository.lockItem(accountUserId, itemId, tx);
          holderReady.resolve(undefined);
          await releaseHolder.promise;
        },
      };
      const holderMutation = createWithUserMutation({
        db: testDb.db,
        cache,
        publishInvalidation: async () => undefined,
      });
      const waiterMutation = createWithUserMutation({
        db: peerClient.db,
        cache,
        publishInvalidation: async () => undefined,
      });
      const unlinkActiveItem = async () => {
        unlinkCalls += 1;
        return true;
      };
      const holderService = createAccountService({
        repository: holderRepository,
        cache,
        withUserMutation: (accountUserId, callback) =>
          holderMutation(accountUserId, async (tx) => {
            holderPid = await getTransactionBackendPid(tx);
            return callback(tx);
          }),
        unlinkActiveItem: { unlinkActiveItem },
      });
      let waiterPid: number | undefined;
      const waiterReady = deferred<void>();
      const waiterService = createAccountService({
        repository: createAccountRepository(peerClient.db),
        cache,
        withUserMutation: async (accountUserId, callback) =>
          waiterMutation(accountUserId, async (tx) => {
            waiterPid = await getTransactionBackendPid(tx);
            waiterReady.resolve(undefined);
            return callback(tx);
          }),
        unlinkActiveItem: { unlinkActiveItem },
      });
      const holderDeletion = holderService.removeAccount(userId, first.id);
      await holderReady.promise;
      const waiterDeletion = waiterService.removeAccount(userId, second.id);
      await waiterReady.promise;
      if (waiterPid === undefined)
        throw new Error("waiter PID was not captured");
      if (holderPid === undefined)
        throw new Error("holder PID was not captured");
      await waitForBlockedBackend(observerClient.client, waiterPid, holderPid);
      releaseHolder.resolve(undefined);
      await expect(
        Promise.all([holderDeletion, waiterDeletion]),
      ).resolves.toEqual([
        { removed: true, unlinkedItem: false },
        { removed: true, unlinkedItem: true },
      ]);
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
    let peer: IsolatedSchemaClient | undefined;
    let observer: IsolatedSchemaClient | undefined;
    try {
      peer = await testDb.createPeerClient();
      observer = await testDb.createPeerClient();
      const peerClient = peer;
      const observerClient = observer;
      const owner = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const holderReady = deferred<void>();
      const releaseHolder = deferred<void>();
      let holderPid: number | undefined;
      const holder = testDb.db.transaction(async (tx) => {
        holderPid = await getTransactionBackendPid(tx);
        await tx.insert(accounts).values({
          userId: owner.userId,
          plaidItemId: owner.item.id,
          plaidAccountId: "account-race",
          name: "Checking",
          type: "depository",
          subtype: "checking",
          mask: "1234",
          currency: "USD",
          currentBalance: 10001n,
        });
        holderReady.resolve(undefined);
        await releaseHolder.promise;
      });
      await holderReady.promise;
      const peerRepository = createAccountRepository(peerClient.db);
      let waiterPid: number | undefined;
      const waiterReady = deferred<void>();
      const waiter = peerClient.db.transaction(async (tx) => {
        waiterPid = await getTransactionBackendPid(tx);
        waiterReady.resolve(undefined);
        return peerRepository.upsertFromPlaid(
          {
            userId: owner.userId,
            plaidItemUuid: owner.item.id,
            account: plaidAccount("account-race"),
          },
          tx,
        );
      });
      await waiterReady.promise;
      if (waiterPid === undefined)
        throw new Error("waiter PID was not captured");
      if (holderPid === undefined)
        throw new Error("holder PID was not captured");
      await waitForBlockedBackend(observerClient.client, waiterPid, holderPid);
      releaseHolder.resolve(undefined);
      await holder;
      const reconciled = await waiter;
      expect(reconciled.plaidAccountId).toBe("account-race");
      await expect(
        repository.findByPlaidAccountId("account-race", owner.userId),
      ).resolves.toMatchObject({ id: reconciled.id });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("preserves a committed deletion when a same-item sync was waiting on the row lock", async () => {
    const testDb = await createIsolatedTestDatabase();
    let peer: IsolatedSchemaClient | undefined;
    let observer: IsolatedSchemaClient | undefined;
    try {
      peer = await testDb.createPeerClient();
      observer = await testDb.createPeerClient();
      const peerClient = peer;
      const observerClient = observer;
      const { userId, item } = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const peerRepository = createAccountRepository(peerClient.db);
      const account = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-serial-delete"),
      });
      const rowLockReady = deferred<void>();
      const releaseDelete = deferred<void>();
      let holderPid: number | undefined;
      const deletion = testDb.db.transaction(async (tx) => {
        holderPid = await getTransactionBackendPid(tx);
        await repository.findByIdForUpdate(userId, account.id, tx);
        rowLockReady.resolve(undefined);
        await releaseDelete.promise;
        await repository.softDelete(userId, account.id, tx);
      });
      await rowLockReady.promise;
      let waiterPid: number | undefined;
      const waiterReady = deferred<void>();
      const sync = peerClient.db.transaction(async (tx) => {
        waiterPid = await getTransactionBackendPid(tx);
        waiterReady.resolve(undefined);
        return peerRepository.upsertFromPlaid(
          {
            userId,
            plaidItemUuid: item.id,
            account: plaidAccount("account-serial-delete"),
          },
          tx,
        );
      });
      await waiterReady.promise;
      if (waiterPid === undefined)
        throw new Error("waiter PID was not captured");
      if (holderPid === undefined)
        throw new Error("holder PID was not captured");
      await waitForBlockedBackend(observerClient.client, waiterPid, holderPid);
      releaseDelete.resolve(undefined);
      await deletion;
      const synced = await sync;
      expect(synced.deletedAt).toEqual(expect.any(Date));
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("does not let a relink bypass the delete transaction's decisive row lock", async () => {
    const testDb = await createIsolatedTestDatabase();
    let peer: IsolatedSchemaClient | undefined;
    let observer: IsolatedSchemaClient | undefined;
    try {
      peer = await testDb.createPeerClient();
      observer = await testDb.createPeerClient();
      const peerClient = peer;
      const observerClient = observer;
      const { userId, item } = await setup(testDb.db);
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
      const repository = createAccountRepository(testDb.db);
      const peerRepository = createAccountRepository(peerClient.db);
      const account = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-serial-relink"),
      });
      const rowLockReady = deferred<void>();
      const releaseDelete = deferred<void>();
      let holderPid: number | undefined;
      const deletion = testDb.db.transaction(async (tx) => {
        holderPid = await getTransactionBackendPid(tx);
        await repository.findByIdForUpdate(userId, account.id, tx);
        rowLockReady.resolve(undefined);
        await releaseDelete.promise;
        await repository.softDelete(userId, account.id, tx);
      });
      await rowLockReady.promise;
      let waiterPid: number | undefined;
      const waiterReady = deferred<void>();
      const relink = peerClient.db.transaction(async (tx) => {
        waiterPid = await getTransactionBackendPid(tx);
        waiterReady.resolve(undefined);
        return peerRepository.upsertFromPlaid(
          {
            userId,
            plaidItemUuid: newItem.id,
            account: plaidAccount("account-serial-relink"),
          },
          tx,
        );
      });
      await waiterReady.promise;
      if (waiterPid === undefined)
        throw new Error("waiter PID was not captured");
      if (holderPid === undefined)
        throw new Error("holder PID was not captured");
      await waitForBlockedBackend(observerClient.client, waiterPid, holderPid);
      releaseDelete.resolve(undefined);
      await deletion;
      await expect(relink).resolves.toMatchObject({ plaidItemId: newItem.id });
      await expect(
        repository.findById(userId, account.id),
      ).resolves.toMatchObject({
        plaidItemId: newItem.id,
        deletedAt: null,
      });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("waits for a concurrent new account before deciding the item is last-live", async () => {
    const testDb = await createIsolatedTestDatabase();
    let peer: IsolatedSchemaClient | undefined;
    let observer: IsolatedSchemaClient | undefined;
    try {
      peer = await testDb.createPeerClient();
      observer = await testDb.createPeerClient();
      const peerClient = peer;
      const observerClient = observer;
      const { userId, item } = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const account = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-serial-last-live"),
      });
      const itemLockReady = deferred<void>();
      const releaseWriter = deferred<void>();
      const writerRepository = createAccountRepository(peerClient.db);
      let holderPid: number | undefined;
      const writer = peerClient.db.transaction(async (tx) => {
        holderPid = await getTransactionBackendPid(tx);
        await writerRepository.lockItem(userId, item.id, tx);
        itemLockReady.resolve(undefined);
        await releaseWriter.promise;
        await writerRepository.upsertFromPlaid(
          {
            userId,
            plaidItemUuid: item.id,
            account: plaidAccount("account-serial-new"),
          },
          tx,
        );
      });
      await itemLockReady.promise;
      const cache = createResponseCache();
      let waiterPid: number | undefined;
      const waiterReady = deferred<void>();
      const service = createAccountService({
        repository,
        cache,
        withUserMutation: async (_userId, callback) =>
          testDb.db.transaction(async (tx) => {
            waiterPid = await getTransactionBackendPid(tx);
            waiterReady.resolve(undefined);
            return callback(tx);
          }),
        unlinkActiveItem: {
          unlinkActiveItem: async () => true,
        },
      });
      const deletion = service.removeAccount(userId, account.id);
      await waiterReady.promise;
      if (waiterPid === undefined)
        throw new Error("waiter PID was not captured");
      if (holderPid === undefined)
        throw new Error("holder PID was not captured");
      await waitForBlockedBackend(observerClient.client, waiterPid, holderPid);
      releaseWriter.resolve(undefined);
      await writer;
      await expect(deletion).resolves.toEqual({
        removed: true,
        unlinkedItem: false,
      });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("provides the narrow public writer factory and runs a root write transaction", async () => {
    const testDb = await createIsolatedTestDatabase();
    try {
      const { userId, item } = await setup(testDb.db);
      const writer = createPlaidAccountWriter(testDb.db);
      await expect(
        writer.upsertFromPlaid({
          userId,
          plaidItemUuid: item.id,
          account: plaidAccount("account-public-writer"),
        }),
      ).resolves.toMatchObject({ userId, plaidItemId: item.id });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("rejects a sync when its target item is soft-deleted while it waits for membership", async () => {
    const testDb = await createIsolatedTestDatabase();
    let peer: IsolatedSchemaClient | undefined;
    let observer: IsolatedSchemaClient | undefined;
    try {
      peer = await testDb.createPeerClient();
      observer = await testDb.createPeerClient();
      const peerClient = peer;
      const observerClient = observer;
      const { userId, item } = await setup(testDb.db);
      const repository = createAccountRepository(testDb.db);
      const peerRepository = createAccountRepository(peerClient.db);
      const account = await repository.upsertFromPlaid({
        userId,
        plaidItemUuid: item.id,
        account: plaidAccount("account-target-delete"),
      });
      const itemLockReady = deferred<void>();
      const releaseItemDelete = deferred<void>();
      let holderPid: number | undefined;
      const itemDelete = testDb.db.transaction(async (tx) => {
        holderPid = await getTransactionBackendPid(tx);
        await repository.lockItem(userId, item.id, tx);
        await tx
          .update(plaidItems)
          .set({ deletedAt: new Date() })
          .where(eq(plaidItems.id, item.id));
        itemLockReady.resolve(undefined);
        await releaseItemDelete.promise;
      });
      await itemLockReady.promise;
      let waiterPid: number | undefined;
      const waiterReady = deferred<void>();
      const sync = peerClient.db.transaction(async (tx) => {
        waiterPid = await getTransactionBackendPid(tx);
        waiterReady.resolve(undefined);
        return peerRepository.upsertFromPlaid(
          {
            userId,
            plaidItemUuid: item.id,
            account: plaidAccount("account-target-delete"),
          },
          tx,
        );
      });
      await waiterReady.promise;
      if (waiterPid === undefined)
        throw new Error("waiter PID was not captured");
      if (holderPid === undefined)
        throw new Error("holder PID was not captured");
      await waitForBlockedBackend(observerClient.client, waiterPid, holderPid);
      releaseItemDelete.resolve(undefined);
      await itemDelete;
      await expect(sync).rejects.toThrow("Plaid item");
      await expect(
        repository.findById(userId, account.id),
      ).resolves.toMatchObject({
        plaidItemId: item.id,
        deletedAt: null,
      });
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
