import { describe, expect, it, vi } from "vitest";

import { createResponseCache } from "../../../platform/cache/response-cache.js";
import { createWithUserMutation } from "../../../platform/cache/user-revisions.repository.js";
import type { UserMutationService } from "../../../platform/cache/user-revisions.repository.js";
import type { DbTransaction } from "../../../platform/database/types.js";
import { createAccountService } from "../accounts.service.js";
import type {
  AccountRepository,
  AccountRow,
  AccountWithItem,
  PlaidItemRow,
} from "../accounts.repository.js";
import {
  toAccountAuditSnapshot,
  toAccountSummary,
} from "../accounts.mapper.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";

const row: AccountRow = {
  id: ACCOUNT_ID,
  userId: USER_ID,
  plaidItemId: ITEM_ID,
  plaidAccountId: "pa-1",
  name: "Checking",
  nameOverride: null,
  officialName: null,
  type: "depository",
  subtype: "checking",
  mask: "1234",
  currency: "USD",
  currentBalance: 12345n,
  availableBalance: null,
  limit: null,
  limitOverride: null,
  apr: null,
  apy: null,
  minimumPayment: null,
  paymentDueDate: null,
  paymentDueDateOverride: null,
  statementBalance: null,
  statementDate: null,
  originationDate: null,
  maturityDate: null,
  color: null,
  icon: null,
  isHidden: false,
  excludeFromNetWorth: false,
  excludeFromBudgets: false,
  excludeFromForecast: false,
  defaultMemberId: null,
  displayOrder: 0,
  isManual: false,
  archivedAt: null,
  balanceLastRefreshedAt: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  deletedAt: null,
};
const deletedRow: AccountRow = {
  ...row,
  deletedAt: new Date("2026-09-02T00:00:00.000Z"),
};
const joined: AccountWithItem = {
  ...row,
  plaidItem: {
    id: ITEM_ID,
    status: "active",
    errorCode: null,
    institutionId: "ins",
    institutionName: "Bank",
  },
};
const ownedItem = Object.assign(Object.create(null), {
  deletedAt: null,
}) as PlaidItemRow;

function mutationDouble(tx: DbTransaction): {
  mutation: UserMutationService["withUserMutation"];
  calls: () => number;
} {
  let count = 0;
  const mutation: UserMutationService["withUserMutation"] = async <T>(
    _userId: string,
    mutate: (transaction: DbTransaction) => Promise<T>,
  ): Promise<T> => {
    count += 1;
    return mutate(tx);
  };
  return { mutation, calls: () => count };
}

function repository(): AccountRepository {
  return {
    listByUser: vi.fn(async () => [joined]),
    findById: vi.fn(async () => row),
    findByIdForUpdate: vi.fn(async () => row),
    findOwnedItem: vi.fn(async () => ownedItem),
    findOwnedItemForUpdate: vi.fn(async () => ownedItem),
    findByPlaidAccountId: vi.fn(async () => row),
    findByPlaidAccountIds: vi.fn(async () => [row]),
    findByItem: vi.fn(async () => [row]),
    upsertFromPlaid: vi.fn(async () => row),
    updateBalances: vi.fn(async () => row),
    updateLiabilities: vi.fn(async () => true),
    lockItem: vi.fn(async () => undefined),
    softDelete: vi.fn(async () => deletedRow),
    countLiveByItem: vi.fn(async () => 0),
    insertManualAccount: vi.fn(async () => row),
    updateManualAccount: vi.fn(async () => row),
    updateLinkedAccount: vi.fn(async () => row),
    recordAudit: vi.fn(async () => undefined),
  };
}

describe("accounts service", () => {
  it("returns user account overrides as the effective linked account metadata", () => {
    const account = {
      ...joined,
      nameOverride: "Everyday card",
      limitOverride: 250000n,
      paymentDueDateOverride: "2026-10-22",
      color: "blue",
      icon: "credit-card",
    };

    expect(toAccountSummary(account)).toMatchObject({
      name: "Everyday card",
      limit: "250000",
      paymentDueDate: "2026-10-22",
      color: "blue",
      icon: "credit-card",
    });
  });

  it("creates a manual account, deriving type and storing a positive credit-card balance", async () => {
    const repo = repository();
    const manualRow: AccountRow = {
      ...row,
      plaidItemId: null,
      plaidAccountId: null,
      type: "credit",
      subtype: "credit_card",
      currentBalance: 50000n,
      availableBalance: 50000n,
      limit: 200000n,
      isManual: true,
    };
    const insertManualAccount = vi.fn(async () => manualRow);
    const tx = {} as DbTransaction;
    const withUserMutation = mutationDouble(tx);
    const service = createAccountService({
      repository: { ...repo, insertManualAccount },
      withUserMutation: withUserMutation.mutation,
    });
    const created = await service.createManualAccount(USER_ID, {
      name: "Visa",
      subtype: "credit_card",
      openingBalanceCents: 50000n,
      limitCents: 200000n,
    });
    expect(insertManualAccount).toHaveBeenCalledWith(
      USER_ID,
      {
        name: "Visa",
        type: "credit",
        subtype: "credit_card",
        currentBalance: 50000n,
        limit: 200000n,
      },
      tx,
    );
    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", entityId: manualRow.id }),
      tx,
    );
    expect(created).toMatchObject({
      isManual: true,
      plaidItem: null,
      currentBalance: "50000",
      limit: "200000",
    });
  });

  it("rejects a negative credit-card opening balance", async () => {
    const repo = repository();
    const service = createAccountService({
      repository: repo,
      withUserMutation: mutationDouble({} as DbTransaction).mutation,
    });
    await expect(
      service.createManualAccount(USER_ID, {
        name: "Visa",
        subtype: "credit_card",
        openingBalanceCents: -100n,
      }),
    ).rejects.toThrow(/positive/);
  });

  it("caches account summaries by user revision", async () => {
    const repo = repository();
    const service = createAccountService({
      repository: repo,
      cache: createResponseCache(),
      getUserRevision: async () => 1n,
    });
    await service.listAccountSummaries(USER_ID);
    await service.listAccountSummaries(USER_ID);
    expect(repo.listByUser).toHaveBeenCalledTimes(1);
  });

  it("runs delete, audit, and live-account count in one mutation transaction", async () => {
    const repo = repository();
    const tx = {} as DbTransaction;
    const withUserMutation = mutationDouble(tx);
    const unlinkActiveItem = vi.fn(async () => true);
    const service = createAccountService({
      repository: repo,
      withUserMutation: withUserMutation.mutation,
      unlinkActiveItem: { unlinkActiveItem },
    });
    await expect(service.removeAccount(USER_ID, ACCOUNT_ID)).resolves.toEqual({
      removed: true,
      unlinkedItem: true,
    });
    expect(withUserMutation.calls()).toBe(1);
    expect(repo.lockItem).toHaveBeenCalledWith(USER_ID, ITEM_ID, tx);
    expect(repo.softDelete).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, tx);
    expect(repo.countLiveByItem).toHaveBeenCalledWith(USER_ID, ITEM_ID, tx);
    expect(repo.recordAudit).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        entityId: ACCOUNT_ID,
        action: "delete",
        source: "accounts.remove",
        before: toAccountAuditSnapshot(row),
        after: toAccountAuditSnapshot(deletedRow),
      },
      tx,
    );
    expect(unlinkActiveItem).toHaveBeenCalledWith({
      userId: USER_ID,
      itemId: ITEM_ID,
    });
  });

  it("takes the decisive account row lock before trusting its linked item", async () => {
    const repo = repository();
    const findByIdForUpdate = vi.fn(async () => row);
    const findOwnedItem = vi.fn(async () => ownedItem);
    const lockedRepository: AccountRepository = {
      ...repo,
      findByIdForUpdate,
      findOwnedItem,
    };
    const tx = {} as DbTransaction;
    const mutation = mutationDouble(tx);
    await createAccountService({
      repository: lockedRepository,
      withUserMutation: mutation.mutation,
    }).removeAccount(USER_ID, ACCOUNT_ID);
    expect(findByIdForUpdate).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, tx);
    expect(findByIdForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      findOwnedItem.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("revalidates and locks the owned item before deciding whether to unlink", async () => {
    const repo = repository();
    const lockItem = vi.fn(async () => undefined);
    const findOwnedItemForUpdate = vi.fn(async () => ownedItem);
    const lockedRepository: AccountRepository = {
      ...repo,
      lockItem,
      findOwnedItemForUpdate,
    };
    const tx = {} as DbTransaction;
    const mutation = mutationDouble(tx);
    await createAccountService({
      repository: lockedRepository,
      withUserMutation: mutation.mutation,
    }).removeAccount(USER_ID, ACCOUNT_ID);
    expect(findOwnedItemForUpdate).toHaveBeenCalledWith(USER_ID, ITEM_ID, tx);
    const lockCall = lockItem.mock.invocationCallOrder[0];
    const itemCall = findOwnedItemForUpdate.mock.invocationCallOrder[0];
    expect(lockCall).toBeDefined();
    expect(itemCall).toBeDefined();
    if (lockCall !== undefined && itemCall !== undefined)
      expect(lockCall).toBeLessThan(itemCall);
  });

  it("passes the active transaction to refresh and invalidates the writer cache", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const tx = {} as DbTransaction;
    const withUserMutation = mutationDouble(tx);
    const refreshAccountBalance = vi.fn(
      async (input: {
        userId: string;
        accountId: string;
        tx: DbTransaction;
      }) => {
        expect(input.tx).toBe(tx);
        return {
          accountId: input.accountId,
          plaidAccountId: "pa-1",
          current: 1,
          available: null,
          limit: null,
          currency: "USD",
        };
      },
    );
    const service = createAccountService({
      repository: repo,
      cache,
      getUserRevision: async () => 0n,
      withUserMutation: withUserMutation.mutation,
      refresher: { refreshAccountBalance },
    });
    await service.listAccountSummaries(USER_ID);
    await expect(
      service.refreshAccountBalance(USER_ID, ACCOUNT_ID),
    ).resolves.toMatchObject({ current: 1 });
    expect(withUserMutation.calls()).toBe(1);
  });

  it("does not invalidate the cache when refresh fails", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const withUserMutation = mutationDouble({} as DbTransaction);
    const service = createAccountService({
      repository: repo,
      cache,
      getUserRevision: async () => 0n,
      withUserMutation: withUserMutation.mutation,
      refresher: {
        refreshAccountBalance: async () => {
          throw new Error("failed");
        },
      },
    });
    await service.listAccountSummaries(USER_ID);
    await expect(
      service.refreshAccountBalance(USER_ID, ACCOUNT_ID),
    ).rejects.toThrow("failed");
    expect(cache.stats().userInvalidations).toBe(0);
  });

  it("keeps committed removal when the adapter fails", async () => {
    const repo = repository();
    const unlinkActiveItem = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    const withUserMutation = mutationDouble({} as DbTransaction);
    const service = createAccountService({
      repository: repo,
      withUserMutation: withUserMutation.mutation,
      unlinkActiveItem: { unlinkActiveItem },
      logger: { error: vi.fn() },
    });
    await expect(service.removeAccount(USER_ID, ACCOUNT_ID)).resolves.toEqual({
      removed: true,
      unlinkedItem: false,
    });
  });

  it("serializes every audit field without bigint or Date values", () => {
    expect(
      toAccountAuditSnapshot({
        ...row,
        deletedAt: new Date("2026-09-02T00:00:00.000Z"),
      }),
    ).toEqual({
      id: ACCOUNT_ID,
      userId: USER_ID,
      plaidItemId: ITEM_ID,
      plaidAccountId: "pa-1",
      name: "Checking",
      nameOverride: null,
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: "1234",
      currency: "USD",
      currentBalance: "12345",
      availableBalance: null,
      limit: null,
      limitOverride: null,
      apr: null,
      apy: null,
      minimumPayment: null,
      paymentDueDate: null,
      paymentDueDateOverride: null,
      statementBalance: null,
      statementDate: null,
      originationDate: null,
      maturityDate: null,
      color: null,
      icon: null,
      isHidden: false,
      excludeFromNetWorth: false,
      excludeFromBudgets: false,
      excludeFromForecast: false,
      defaultMemberId: null,
      displayOrder: 0,
      isManual: false,
      archivedAt: null,
      balanceLastRefreshedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      deletedAt: "2026-09-02T00:00:00.000Z",
    });
  });

  it("removes an account with a missing or foreign item but never requests unlink", async () => {
    const repo = repository();
    vi.mocked(repo.findOwnedItem).mockResolvedValue(null);
    const withUserMutation = mutationDouble({} as DbTransaction);
    const unlinkActiveItem = vi.fn(async () => true);
    const service = createAccountService({
      repository: repo,
      withUserMutation: withUserMutation.mutation,
      unlinkActiveItem: { unlinkActiveItem },
    });
    await expect(service.removeAccount(USER_ID, ACCOUNT_ID)).resolves.toEqual({
      removed: true,
      unlinkedItem: false,
    });
    expect(unlinkActiveItem).not.toHaveBeenCalled();
    expect(repo.softDelete).toHaveBeenCalled();
  });

  it("retains a committed delete when post-commit logging itself fails", async () => {
    const repo = repository();
    const withUserMutation = mutationDouble({} as DbTransaction);
    const service = createAccountService({
      repository: repo,
      withUserMutation: withUserMutation.mutation,
      unlinkActiveItem: {
        unlinkActiveItem: async () => {
          throw new Error("upstream");
        },
      },
      logger: {
        error: async () => {
          throw new Error("logger down");
        },
      },
    });
    await expect(service.removeAccount(USER_ID, ACCOUNT_ID)).resolves.toEqual({
      removed: true,
      unlinkedItem: false,
    });
  });

  it("uses the real mutation protocol for cache eviction and revision accounting", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const tx = {} as DbTransaction;
    let revisions = 0;
    const mutation = createWithUserMutation({
      db: {
        transaction: async <T>(
          callback: (transaction: DbTransaction) => Promise<T>,
        ) => callback(tx),
      },
      cache,
      incrementRevision: async () => {
        revisions += 1;
        return BigInt(revisions);
      },
      publishInvalidation: async () => undefined,
    });
    const service = createAccountService({
      repository: repo,
      cache,
      getUserRevision: async () => 0n,
      withUserMutation: mutation,
      refresher: {
        refreshAccountBalance: async ({ accountId }) => ({
          accountId,
          plaidAccountId: "pa-1",
          current: 1,
          available: null,
          limit: null,
          currency: "USD",
        }),
      },
    });
    await service.listAccountSummaries(USER_ID);
    await service.refreshAccountBalance(USER_ID, ACCOUNT_ID);
    expect(revisions).toBe(1);
    expect(cache.stats().userInvalidations).toBe(1);
  });

  it("does not evict or increment revision when refresh fails", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const tx = {} as DbTransaction;
    let revisions = 0;
    const mutation = createWithUserMutation({
      db: {
        transaction: async <T>(
          callback: (transaction: DbTransaction) => Promise<T>,
        ) => callback(tx),
      },
      cache,
      incrementRevision: async () => {
        revisions += 1;
        return BigInt(revisions);
      },
      publishInvalidation: async () => undefined,
    });
    const service = createAccountService({
      repository: repo,
      cache,
      getUserRevision: async () => 0n,
      withUserMutation: mutation,
      refresher: {
        refreshAccountBalance: async () => {
          throw new Error("failed");
        },
      },
    });
    await service.listAccountSummaries(USER_ID);
    await expect(
      service.refreshAccountBalance(USER_ID, ACCOUNT_ID),
    ).rejects.toThrow("failed");
    expect(revisions).toBe(0);
    expect(cache.stats().userInvalidations).toBe(0);
  });
});

describe("manual account edits", () => {
  const manual: AccountRow = {
    ...row,
    plaidItemId: null,
    plaidAccountId: null,
    type: "credit",
    subtype: "credit_card",
    limit: 100000n,
    isManual: true,
  };
  const setup = (current: AccountRow) => {
    const repo = repository();
    const updateManualAccount = vi.fn(
      async (_u: string, _id: string, patch: Partial<AccountRow>) => ({
        ...current,
        ...patch,
      }),
    );
    const recordAudit = vi.fn(async () => undefined);
    const service = createAccountService({
      repository: {
        ...repo,
        findByIdForUpdate: vi.fn(async () => current),
        findById: vi.fn(async () => current),
        updateManualAccount,
        recordAudit,
      },
      withUserMutation: mutationDouble({} as DbTransaction).mutation,
    });
    return { service, updateManualAccount, recordAudit };
  };

  it("renames, changes the limit, and archives in one audited update", async () => {
    const { service, updateManualAccount, recordAudit } = setup(manual);
    const result = await service.updateAccount(USER_ID, ACCOUNT_ID, {
      name: "Travel card",
      limitCents: 250000n,
      archived: true,
    });
    const patch = updateManualAccount.mock.calls[0]![2];
    expect(patch).toMatchObject({ name: "Travel card", limit: 250000n });
    expect(patch.archivedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ name: "Travel card", limit: "250000" });
    expect(result.archivedAt).not.toBeNull();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        source: "accounts.update-manual",
      }),
      expect.anything(),
    );
  });

  it("stores linked account name and limit edits as sync-safe overrides", async () => {
    const linked: AccountRow = {
      ...row,
      type: "credit",
      subtype: "credit_card",
      limit: 100000n,
      isManual: false,
    };
    const updateLinkedAccount = vi.fn(async () => ({
      ...linked,
      nameOverride: "Everyday card",
      limitOverride: 250000n,
      paymentDueDateOverride: "2026-10-22",
      color: "blue",
      icon: "credit-card",
    }));
    const repo = Object.assign(repository(), {
      findByIdForUpdate: vi.fn(async () => linked),
      updateLinkedAccount,
    });
    const service = createAccountService({
      repository: repo,
      withUserMutation: mutationDouble({} as DbTransaction).mutation,
    });

    await expect(
      service.updateAccount(USER_ID, ACCOUNT_ID, {
        name: "Everyday card",
        limitCents: 250000n,
        paymentDueDate: "2026-10-22",
        color: "blue",
        icon: "credit-card",
      }),
    ).resolves.toMatchObject({
      name: "Everyday card",
      limit: "250000",
      paymentDueDate: "2026-10-22",
      color: "blue",
      icon: "credit-card",
    });
    expect(updateLinkedAccount).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      {
        nameOverride: "Everyday card",
        limitOverride: 250000n,
        paymentDueDateOverride: "2026-10-22",
        color: "blue",
        icon: "credit-card",
      },
      expect.anything(),
    );
  });

  it("unarchives by clearing archivedAt and keeps an existing archive date when re-archived", async () => {
    const archivedAt = new Date("2026-09-10T00:00:00.000Z");
    const { service, updateManualAccount } = setup({ ...manual, archivedAt });
    await service.updateAccount(USER_ID, ACCOUNT_ID, { archived: false });
    await service.updateAccount(USER_ID, ACCOUNT_ID, { archived: true });
    expect(updateManualAccount.mock.calls[0]![2]).toEqual({ archivedAt: null });
    expect(updateManualAccount.mock.calls[1]![2]).toEqual({ archivedAt });
  });

  it("returns 422 for linked archive requests and limits on non-credit accounts", async () => {
    await expect(
      setup(row).service.updateAccount(USER_ID, ACCOUNT_ID, { archived: true }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    await expect(
      setup({
        ...manual,
        type: "other",
        subtype: "cash",
        limit: null,
      }).service.updateAccount(USER_ID, ACCOUNT_ID, { limitCents: 1n }),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });

  it("returns 404 for a deleted account", async () => {
    await expect(
      setup({ ...manual, deletedAt: new Date() }).service.updateAccount(
        USER_ID,
        ACCOUNT_ID,
        { name: "X" },
      ),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("rejects deleting a manual account without opening a mutation", async () => {
    const withUserMutation = mutationDouble({} as DbTransaction);
    const service = createAccountService({
      repository: { ...repository(), findById: vi.fn(async () => manual) },
      withUserMutation: withUserMutation.mutation,
    });
    await expect(
      service.removeAccount(USER_ID, ACCOUNT_ID),
    ).rejects.toMatchObject({
      httpStatus: 422,
    });
    expect(withUserMutation.calls()).toBe(0);
  });

  it("leaves archived accounts out of the default list only", async () => {
    const archived: AccountWithItem = {
      ...manual,
      id: "44444444-4444-4444-8444-444444444444",
      archivedAt: new Date("2026-09-10T00:00:00.000Z"),
      plaidItem: null,
    };
    const service = createAccountService({
      repository: {
        ...repository(),
        listByUser: vi.fn(async () => [joined, archived]),
      },
      cache: {
        getOrCompute: async (_k: unknown, read: () => Promise<unknown>) =>
          read(),
      } as never,
      getUserRevision: async () => 1n,
    });
    expect(
      (await service.listAccountSummaries(USER_ID)).map((a) => a.id),
    ).toEqual([ACCOUNT_ID]);
    expect(
      (
        await service.listAccountSummaries(USER_ID, { includeArchived: true })
      ).map((a) => a.id),
    ).toEqual([ACCOUNT_ID, archived.id]);
  });
});
