import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../platform/errors/app-error.js";
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
  ArchiveCategoryOptions,
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
  /**
   * Archives a category after moving what uses it to `reassignTo` (default:
   * its parent, or uncategorised for a group). Its subcategories become
   * top-level groups.
   */
  archiveCategory: (
    userId: string,
    id: string,
    options?: ArchiveCategoryOptions,
  ) => Promise<{ reassignedTo: string | null; movedTransactions: number }>;
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
  /**
   * Two levels only: a parent is a visible top-level category other than
   * this one, and a category with subcategories can't become one.
   */
  const assertMove = async (
    userId: string,
    target: CategoryRow,
    requestedId: string,
    parentId: string | null,
    tx: DbTransaction,
  ) => {
    if (parentId === null) {
      if (
        target.parentId !== null &&
        (await repository.findOwnTopLevelByName(
          userId,
          target.name,
          target.id,
          tx,
        ))
      )
        throw new ConflictError(
          `You already have a group named ${target.name}; rename one first.`,
        );
      return;
    }
    if (parentId === target.id || parentId === requestedId)
      throw new ValidationError("A category can't be its own parent.");
    const parent = await repository.getCategoryById(userId, parentId, tx);
    if (!parent)
      throw new ValidationError(
        "parentId does not exist or is not accessible to this user.",
      );
    if (parent.parentId !== null)
      throw new ValidationError(
        "Subcategories can't have subcategories; choose a top-level category.",
      );
    if ((await repository.listChildren(userId, target.id, tx)).length > 0)
      throw new ValidationError(
        "Move or delete this category's subcategories first.",
      );
  };

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
        if (input.parentId !== undefined) {
          await assertMove(userId, target, existing.id, input.parentId, tx);
          updateData.parentId = input.parentId;
        }
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

    async archiveCategory(userId, id, options = {}) {
      const existing = await repository.getCategoryById(userId, id);
      // Only the user's own categories and shared defaults are writable.
      if (!existing || (existing.userId !== null && existing.userId !== userId))
        throw new NotFoundError("category");
      return mutate(userId, async (tx) => {
        const target = await ownedOrCopied(userId, existing, tx);
        let reassignedTo: string | null = target.parentId;
        if (options.reassignTo === "uncategorized") reassignedTo = null;
        else if (options.reassignTo !== undefined) {
          if (
            options.reassignTo === target.id ||
            options.reassignTo === existing.id
          )
            throw new ValidationError(
              "reassignTo must be a different category.",
            );
          const destination = await repository.getCategoryById(
            userId,
            options.reassignTo,
            tx,
          );
          if (!destination)
            throw new ValidationError(
              "reassignTo does not exist or is not accessible to this user.",
            );
          if (destination.parentId === target.id)
            throw new ValidationError(
              "reassignTo can't be a subcategory of the category being deleted.",
            );
          reassignedTo = destination.id;
        }
        // Its subcategories become groups: none may share a group's name.
        for (const child of await repository.listChildren(
          userId,
          target.id,
          tx,
        ))
          if (
            await repository.findOwnTopLevelByName(
              userId,
              child.name,
              child.id,
              tx,
            )
          )
            throw new ConflictError(
              `${child.name} would become a group, but you already have one with that name; rename it first.`,
            );
        const promotedChildren = await repository.promoteChildren(
          userId,
          target.id,
          tx,
        );
        const moved = await repository.moveReferences(
          userId,
          target.id,
          reassignedTo,
          tx,
        );
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
            after: {
              ...archived,
              reassignedTo,
              movedTransactions: moved.transactions,
              promotedChildren,
            },
          },
          tx,
        );
        return { reassignedTo, movedTransactions: moved.transactions };
      });
    },
  };
}
