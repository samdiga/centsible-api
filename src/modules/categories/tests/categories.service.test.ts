import { describe, expect, it, vi } from "vitest";

import { NotFoundError } from "../../../platform/errors/app-error.js";
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
  it("maps persistence rows to category DTOs when listing", async () => {
    const repo = repository();
    const service = createCategoryService({ repository: repo });

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
