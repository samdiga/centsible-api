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
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

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
    recordAudit: vi.fn(async () => undefined),
  };
}

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
