import { NotFoundError } from "../../platform/errors/app-error.js";
import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import { getUserRevision } from "../../platform/cache/user-revisions.repository.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import {
  categoryRepository,
  type CategoryRepository,
} from "./categories.repository.js";
import { toCategoryDto } from "./categories.mapper.js";
import type {
  CategoryDto,
  CreateCategoryInput,
  UpdateCategoryInput,
} from "./categories.schemas.js";

export type CategoryService = Readonly<{
  listCategories: (userId: string) => Promise<CategoryDto[]>;
  createCategory: (
    userId: string,
    input: CreateCategoryInput,
  ) => Promise<CategoryDto>;
  updateCategory: (
    userId: string,
    id: string,
    input: UpdateCategoryInput,
  ) => Promise<CategoryDto>;
  archiveCategory: (userId: string, id: string) => Promise<boolean>;
}>;

export type CategoryServiceDependencies = Readonly<{
  repository?: CategoryRepository;
  cache?: CategoryCache;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
}>;

export type CategoryCache = Pick<
  ResponseCache,
  "getOrCompute" | "invalidateUser" | "invalidateAllUsers"
>;

export type { CategoryRepository } from "./categories.repository.js";

type Mutation = <T>(
  userId: string,
  callback: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;

function defaultWithUserMutation(
  cache: Pick<ResponseCache, "invalidateUser">,
): UserMutationService["withUserMutation"] {
  return createWithUserMutation({
    db: getDb(),
    cache,
  });
}

export function createCategoryService(
  dependencies: CategoryServiceDependencies = {},
): CategoryService {
  const repository = dependencies.repository ?? categoryRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    (async (userId: string) => getUserRevision(userId, getDb()));
  const suppliedMutation = dependencies.withUserMutation;

  const mutate: Mutation = suppliedMutation
    ? suppliedMutation
    : (userId, callback) => defaultWithUserMutation(cache)(userId, callback);

  return {
    async listCategories(userId) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/categories",
          query: {},
          revision,
        },
        async () => {
          const rows = await repository.listCategories(userId);
          return rows.map(toCategoryDto);
        },
      );
    },

    async createCategory(userId, input) {
      const created = await mutate(userId, async (tx) => {
        const row = await repository.insertCategory(
          userId,
          {
            name: input.name,
            icon: input.icon ?? null,
            color: input.color ?? null,
            isIncome: input.isIncome ?? false,
            excludeFromBudgets: input.excludeFromBudgets ?? false,
            parentId: input.parentId ?? null,
          },
          tx,
        );
        await repository.recordAudit?.(
          {
            userId,
            entityId: row.id,
            action: "create",
            source: "categories.create",
            after: row,
          },
          tx,
        );
        return row;
      });
      return toCategoryDto(created);
    },

    async updateCategory(userId, id, input) {
      const existing = await repository.getCategoryById(userId, id);
      if (!existing) throw new NotFoundError("category");
      const updateData: Parameters<CategoryRepository["updateCategory"]>[2] =
        {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.icon !== undefined) updateData.icon = input.icon;
      if (input.color !== undefined) updateData.color = input.color;
      if (input.excludeFromBudgets !== undefined) {
        updateData.excludeFromBudgets = input.excludeFromBudgets;
      }
      if (input.displayOrder !== undefined) {
        updateData.displayOrder = input.displayOrder;
      }
      const updated = await mutate(userId, async (tx) => {
        const row = await repository.updateCategory(userId, id, updateData, tx);
        if (!row) throw new NotFoundError("category");
        await repository.recordAudit?.(
          {
            userId,
            entityId: id,
            action: "update",
            source: "categories.update",
            before: existing,
            after: row,
          },
          tx,
        );
        return row;
      });
      if (existing.userId === null) cache.invalidateAllUsers(userId);
      return toCategoryDto(updated);
    },

    async archiveCategory(userId, id) {
      const existing = await repository.getCategoryById(userId, id);
      if (!existing) throw new NotFoundError("category");
      await mutate(userId, async (tx) => {
        const archived = await repository.archiveCategory(userId, id, tx);
        if (!archived) throw new NotFoundError("category");
        await repository.recordAudit?.(
          {
            userId,
            entityId: id,
            action: "delete",
            source: "categories.archive",
            before: existing,
            after: archived,
          },
          tx,
        );
        return archived;
      });
      if (existing.userId === null) cache.invalidateAllUsers(userId);
      return true;
    },
  };
}
