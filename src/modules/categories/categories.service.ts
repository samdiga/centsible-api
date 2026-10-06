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
  type CategoryRow,
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
  "getOrCompute" | "invalidateUser"
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
  if (typeof repository.recordAudit !== "function") {
    throw new Error("Categories audit capability is required");
  }
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    (async (userId: string) => getUserRevision(userId, getDb()));
  const suppliedMutation = dependencies.withUserMutation;

  const mutate: Mutation = suppliedMutation
    ? suppliedMutation
    : (userId, callback) => defaultWithUserMutation(cache)(userId, callback);

  /**
   * The row a write applies to: the user's own category, or for a shared
   * default, the user's copy of it (made now if needed). A shared default
   * is everyone's, so it is never written to directly.
   */
  const ownedOrCopied = async (
    userId: string,
    existing: CategoryRow,
    tx: DbTransaction,
  ): Promise<CategoryRow> => {
    if (existing.userId === userId) return existing;
    if (existing.userId !== null) throw new NotFoundError("category");
    const copy = await repository.customizeDefault(userId, existing.id, tx);
    if (!copy) throw new NotFoundError("category");
    await repository.recordAudit(
      {
        userId,
        entityId: copy.id,
        action: "create",
        source: "categories.customize_default",
        before: { defaultCategoryId: existing.id },
        after: copy,
      },
      tx,
    );
    return copy;
  };

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
        await repository.recordAudit(
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
      // Only the user's own categories and shared defaults are writable.
      if (!existing || (existing.userId !== null && existing.userId !== userId))
        throw new NotFoundError("category");
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
        const target = await ownedOrCopied(userId, existing, tx);
        const row = await repository.updateCategory(
          userId,
          target.id,
          updateData,
          tx,
        );
        if (!row) throw new NotFoundError("category");
        await repository.recordAudit(
          {
            userId,
            entityId: target.id,
            action: "update",
            source: "categories.update",
            before: existing,
            after: row,
          },
          tx,
        );
        return row;
      });
      return toCategoryDto(updated);
    },

    async archiveCategory(userId, id) {
      const existing = await repository.getCategoryById(userId, id);
      // Only the user's own categories and shared defaults are writable.
      if (!existing || (existing.userId !== null && existing.userId !== userId))
        throw new NotFoundError("category");
      await mutate(userId, async (tx) => {
        const target = await ownedOrCopied(userId, existing, tx);
        const archived = await repository.archiveCategory(
          userId,
          target.id,
          tx,
        );
        if (!archived) throw new NotFoundError("category");
        await repository.recordAudit(
          {
            userId,
            entityId: target.id,
            action: "delete",
            source: "categories.archive",
            before: existing,
            after: archived,
          },
          tx,
        );
        return archived;
      });
      return true;
    },
  };
}
