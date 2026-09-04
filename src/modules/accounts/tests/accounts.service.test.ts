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
import { toAccountAuditSnapshot } from "../accounts.mapper.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";

const row: AccountRow = {
  id: ACCOUNT_ID,
  userId: USER_ID,
  plaidItemId: ITEM_ID,
  plaidAccountId: "pa-1",
  name: "Checking",
  officialName: null,
  type: "depository",
  subtype: "checking",
  mask: "1234",
  currency: "USD",
  currentBalance: 12345n,
  availableBalance: null,
  limit: null,
  apr: null,
  apy: null,
  minimumPayment: null,
  paymentDueDate: null,
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
    findOwnedItem: vi.fn(async () => ownedItem),
    findByPlaidAccountId: vi.fn(async () => row),
    findByPlaidAccountIds: vi.fn(async () => [row]),
    findByItem: vi.fn(async () => [row]),
    upsertFromPlaid: vi.fn(async () => row),
    updateBalances: vi.fn(async () => row),
    updateLiabilities: vi.fn(async () => true),
    lockItem: vi.fn(async () => undefined),
    softDelete: vi.fn(async () => deletedRow),
    countLiveByItem: vi.fn(async () => 0),
    recordAudit: vi.fn(async () => undefined),
  };
}

describe("accounts service", () => {
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
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: "1234",
      currency: "USD",
      currentBalance: "12345",
      availableBalance: null,
      limit: null,
      apr: null,
      apy: null,
      minimumPayment: null,
      paymentDueDate: null,
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
