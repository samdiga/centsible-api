import { describe, expect, it, vi } from "vitest";

import { NotFoundError } from "../../../platform/errors/app-error.js";
import { createWithUserMutation } from "../../../platform/cache/user-revisions.repository.js";
import { createResponseCache } from "../../../platform/cache/response-cache.js";
import type { Db, DbTransaction } from "../../../platform/database/types.js";
import {
  createCategoryService,
  type CategoryRepository,
} from "../categories.service.js";
import type { CategoryRow } from "../categories.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
const SYSTEM_CATEGORY_ID = "33333333-3333-4333-8333-333333333333";

const row: CategoryRow = {
  id: CATEGORY_ID,
  userId: USER_ID,
  parentId: null,
  name: "Dining",
  icon: "utensils",
  color: "#123456",
  isIncome: false,
  isTransfer: false,
  excludeFromBudgets: false,
  displayOrder: 1,
  archivedAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

function repository(): CategoryRepository {
  return {
    listCategories: vi.fn(async () => [row]),
    getCategoryById: vi.fn(async () => row),
    insertCategory: vi.fn(async () => row),
    updateCategory: vi.fn(async () => ({ ...row, name: "Food" })),
    archiveCategory: vi.fn(async () => ({ ...row, archivedAt: new Date() })),
    customizeDefault: vi.fn(async () => null),
    listChildren: vi.fn(async () => []),
    findOwnTopLevelByName: vi.fn(async () => null),
    promoteChildren: vi.fn(async () => 0),
    moveReferences: vi.fn(async () => ({ transactions: 0 })),
    recordAudit: vi.fn(async () => undefined),
  };
}

/** Runs a mutation callback in place, on the given stand-in transaction. */
const passThrough =
  (tx: DbTransaction) =>
  <T>(_userId: string, callback: (tx: DbTransaction) => Promise<T>) =>
    callback(tx);

describe("categories service", () => {
  function transactionDb(): Pick<Db, "transaction"> {
    return {
      transaction: async <T>(callback: (tx: DbTransaction) => Promise<T>) =>
        callback({} as DbTransaction),
    } as Pick<Db, "transaction">;
  }

  it("caches a user's category list and reuses the cached response", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const service = createCategoryService({
      repository: repo,
      cache,
      getUserRevision: async () => 1n,
    });

    await service.listCategories(USER_ID);
    await service.listCategories(USER_ID);

    expect(repo.listCategories).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("invalidates cached category lists after a committed create", async () => {
    const repo = repository();
    const cache = createResponseCache();
    const withUserMutation = createWithUserMutation({
      db: transactionDb(),
      cache,
      incrementRevision: async () => 2n,
      publishInvalidation: async () => undefined,
    });
    const service = createCategoryService({
      repository: repo,
      cache,
      withUserMutation,
      getUserRevision: async () => 1n,
    });

    await service.listCategories(USER_ID);
    await service.createCategory(USER_ID, {
      name: "Dining",
      isIncome: false,
      excludeFromBudgets: false,
    });

    expect(cache.stats().userInvalidations).toBe(1);
  });

  it("edits and archives the user's copy of a shared default, never the default", async () => {
    const repo = repository();
    const systemRow = { ...row, id: SYSTEM_CATEGORY_ID, userId: null };
    const copy = {
      ...row,
      id: "55555555-5555-4555-8555-555555555555",
      userId: USER_ID,
    };
    vi.mocked(repo.getCategoryById).mockResolvedValue(systemRow);
    vi.mocked(repo.customizeDefault).mockResolvedValue(copy);
    vi.mocked(repo.updateCategory).mockResolvedValue({
      ...copy,
      name: "My Food",
    });
    vi.mocked(repo.archiveCategory).mockResolvedValue({
      ...copy,
      archivedAt: new Date(),
    });
    const tx = {} as DbTransaction;
    const service = createCategoryService({
      repository: repo,
      withUserMutation: passThrough(tx),
      getUserRevision: async () => 1n,
    });

    const updated = await service.updateCategory(USER_ID, SYSTEM_CATEGORY_ID, {
      name: "My Food",
    });
    expect(updated).toMatchObject({ id: copy.id, name: "My Food" });
    expect(repo.customizeDefault).toHaveBeenCalledWith(
      USER_ID,
      SYSTEM_CATEGORY_ID,
      tx,
    );
    expect(repo.updateCategory).toHaveBeenCalledWith(
      USER_ID,
      copy.id,
      { name: "My Food" },
      tx,
    );
    expect(repo.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "categories.customize_default",
        entityId: copy.id,
        before: { defaultCategoryId: SYSTEM_CATEGORY_ID },
      }),
      tx,
    );

    await service.archiveCategory(USER_ID, SYSTEM_CATEGORY_ID);
    expect(repo.archiveCategory).toHaveBeenCalledWith(USER_ID, copy.id, tx);
    for (const call of [
      ...vi.mocked(repo.updateCategory).mock.calls,
      ...vi.mocked(repo.archiveCategory).mock.calls,
    ])
      expect(call[1]).not.toBe(SYSTEM_CATEGORY_ID);
  });

  it("refuses a shared default that can't be copied (archived or gone)", async () => {
    const repo = repository();
    vi.mocked(repo.getCategoryById).mockResolvedValue({
      ...row,
      id: SYSTEM_CATEGORY_ID,
      userId: null,
    });
    vi.mocked(repo.customizeDefault).mockResolvedValue(null);
    const service = createCategoryService({
      repository: repo,
      withUserMutation: passThrough({} as DbTransaction),
      getUserRevision: async () => 1n,
    });
    await expect(
      service.updateCategory(USER_ID, SYSTEM_CATEGORY_ID, { name: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.updateCategory).not.toHaveBeenCalled();
  });

  it("refuses another user's category", async () => {
    const repo = repository();
    vi.mocked(repo.getCategoryById).mockResolvedValue({
      ...row,
      userId: OTHER_USER_ID,
    });
    const withUserMutation = vi.fn();
    const service = createCategoryService({
      repository: repo,
      withUserMutation,
      getUserRevision: async () => 1n,
    });
    await expect(
      service.updateCategory(USER_ID, CATEGORY_ID, { name: "Mine now" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.archiveCategory(USER_ID, CATEGORY_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(withUserMutation).not.toHaveBeenCalled();
  });

  it("keeps another user's cached list after a committed user-owned update", async () => {
    const repo = repository();
    vi.mocked(repo.getCategoryById).mockResolvedValue(row);
    vi.mocked(repo.updateCategory).mockResolvedValue({
      ...row,
      name: "Updated Dining",
    });
    const cache = createResponseCache();
    const withUserMutation = createWithUserMutation({
      db: transactionDb(),
      cache,
      incrementRevision: async () => 1n,
      publishInvalidation: async () => undefined,
    });
    const service = createCategoryService({
      repository: repo,
      cache,
      withUserMutation,
      getUserRevision: async () => 1n,
    });

    await service.listCategories(USER_ID);
    await service.listCategories(OTHER_USER_ID);
    await service.updateCategory(USER_ID, CATEGORY_ID, {
      name: "Updated Dining",
    });
    await service.listCategories(OTHER_USER_ID);

    expect(repo.listCategories).toHaveBeenCalledTimes(2);
    expect(cache.stats().userInvalidations).toBe(1);
  });

  it("does not invalidate a cached list when a global archive fails", async () => {
    const repo = repository();
    const systemRow = { ...row, id: SYSTEM_CATEGORY_ID, userId: null };
    vi.mocked(repo.getCategoryById).mockResolvedValue(systemRow);
    vi.mocked(repo.archiveCategory).mockResolvedValue(null);
    const cache = createResponseCache();
    const withUserMutation = createWithUserMutation({
      db: transactionDb(),
      cache,
      incrementRevision: async () => 1n,
      publishInvalidation: async () => undefined,
    });
    const service = createCategoryService({
      repository: repo,
      cache,
      withUserMutation,
      getUserRevision: async () => 1n,
    });

    await service.listCategories(USER_ID);
    await expect(
      service.archiveCategory(USER_ID, SYSTEM_CATEGORY_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    await service.listCategories(USER_ID);

    expect(repo.listCategories).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, userInvalidations: 0 });
  });

  it("does not invalidate a cached list when an update is a no-op", async () => {
    const repo = repository();
    vi.mocked(repo.getCategoryById).mockResolvedValue(null);
    const cache = createResponseCache();
    const service = createCategoryService({
      repository: repo,
      cache,
      getUserRevision: async () => 1n,
    });

    await service.listCategories(USER_ID);
    await expect(
      service.updateCategory(USER_ID, CATEGORY_ID, { name: "Food" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await service.listCategories(USER_ID);

    expect(cache.stats()).toMatchObject({ hits: 1, userInvalidations: 0 });
    expect(repo.listCategories).toHaveBeenCalledTimes(1);
  });

  it("maps persistence rows to category DTOs when listing", async () => {
    const repo = repository();
    const service = createCategoryService({
      repository: repo,
      getUserRevision: async () => 0n,
    });

    await expect(service.listCategories(USER_ID)).resolves.toEqual([
      {
        id: CATEGORY_ID,
        parentId: null,
        name: "Dining",
        icon: "utensils",
        color: "#123456",
        isIncome: false,
        isTransfer: false,
        excludeFromBudgets: false,
        displayOrder: 1,
        isCustom: true,
      },
    ]);
  });

  it("runs create inside withUserMutation and passes its transaction to the repository", async () => {
    const repo = repository();
    const tx = { marker: "tx" };
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate(tx as never),
    );
    const service = createCategoryService({
      repository: repo,
      withUserMutation,
    });

    await service.createCategory(USER_ID, {
      name: "Dining",
      isIncome: false,
      excludeFromBudgets: false,
    });

    expect(withUserMutation).toHaveBeenCalledTimes(1);
    expect(repo.insertCategory).toHaveBeenCalledWith(
      USER_ID,
      {
        name: "Dining",
        icon: null,
        color: null,
        isIncome: false,
        excludeFromBudgets: false,
        parentId: null,
      },
      tx,
    );
  });

  it("rejects an injected repository without the mandatory audit capability", () => {
    const incompleteRepository = {
      ...repository(),
      recordAudit: undefined,
    } as unknown as CategoryRepository;

    expect(() =>
      createCategoryService({ repository: incompleteRepository }),
    ).toThrow("Categories audit capability is required");
  });

  it("propagates audit failure through the mutation boundary", async () => {
    const repo = repository();
    const auditError = new Error("audit unavailable");
    vi.mocked(repo.recordAudit).mockRejectedValue(auditError);
    let rolledBack = false;
    const withUserMutation = vi.fn(async (_userId, mutate) => {
      try {
        return await mutate({ marker: "tx" } as never);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    const service = createCategoryService({
      repository: repo,
      withUserMutation,
    });

    await expect(
      service.createCategory(USER_ID, {
        name: "Dining",
        isIncome: false,
        excludeFromBudgets: false,
      }),
    ).rejects.toBe(auditError);
    expect(rolledBack).toBe(true);
    expect(withUserMutation).toHaveBeenCalledTimes(1);
  });

  it("throws a typed not-found error and does not mutate a missing category", async () => {
    const repo = repository();
    vi.mocked(repo.getCategoryById).mockResolvedValue(null);
    const withUserMutation = vi.fn();
    const service = createCategoryService({
      repository: repo,
      withUserMutation,
    });

    await expect(
      service.updateCategory(USER_ID, CATEGORY_ID, { name: "Food" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(withUserMutation).not.toHaveBeenCalled();
  });

  it("runs update and archive inside withUserMutation", async () => {
    const repo = repository();
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({ marker: "tx" } as never),
    );
    const service = createCategoryService({
      repository: repo,
      withUserMutation,
    });

    await service.updateCategory(USER_ID, CATEGORY_ID, { name: "Food" });
    await service.archiveCategory(USER_ID, CATEGORY_ID);

    expect(withUserMutation).toHaveBeenCalledTimes(2);
    expect(repo.updateCategory).toHaveBeenCalledWith(
      USER_ID,
      CATEGORY_ID,
      { name: "Food" },
      { marker: "tx" },
    );
    expect(repo.archiveCategory).toHaveBeenCalledWith(USER_ID, CATEGORY_ID, {
      marker: "tx",
    });
  });
});
