import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  getUserRevision,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import { NotFoundError } from "../../platform/errors/app-error.js";
import {
  budgetsRepository,
  type BudgetItemRow,
  type BudgetRepository,
} from "./budgets.repository.js";
import { toBudgetDto } from "./budgets.mapper.js";
import { budgetProgress, currentPeriodRange } from "./budget-calculations.js";
import type {
  BudgetDto,
  BudgetProgress,
  BudgetSuggestion,
  CreateBudgetBody,
} from "./budgets.schemas.js";

export type BudgetItemResult = Readonly<{
  id: string;
  budgetId: string;
  categoryId: string;
  amountCents: string;
}>;

export type BudgetsService = Readonly<{
  getSetupSuggestions: (userId: string) => Promise<BudgetSuggestion[]>;
  getActiveBudget: (userId: string) => Promise<BudgetDto>;
  createBudget: (
    userId: string,
    input: CreateBudgetBody,
  ) => Promise<{ id: string }>;
  getBudgetProgress: (
    userId: string,
    budgetId: string,
  ) => Promise<BudgetProgress>;
  replaceBudgetItems: (
    userId: string,
    budgetId: string,
    items: Array<{ categoryId: string; amountCents: bigint }>,
  ) => Promise<void>;
  upsertBudgetItem: (
    userId: string,
    categoryId: string,
    amountCents: bigint,
  ) => Promise<BudgetItemResult>;
  deleteBudgetItem: (userId: string, categoryId: string) => Promise<boolean>;
}>;

export type BudgetsServiceDependencies = Readonly<{
  repository?: BudgetRepository;
  cache?: Pick<ResponseCache, "getOrCompute" | "invalidateUser">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
}>;

type Mutation = <T>(
  userId: string,
  callback: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;

function defaultMutation(
  cache: Pick<ResponseCache, "invalidateUser">,
): Mutation {
  return createWithUserMutation({ db: getDb(), cache });
}

async function assertCategoriesOwned(
  repository: BudgetRepository,
  userId: string,
  items: Array<{ categoryId: string }>,
  tx: DbTransaction,
): Promise<void> {
  for (const item of items) {
    if (!(await repository.categoryExists(userId, item.categoryId, tx))) {
      throw new NotFoundError("category");
    }
  }
}

function itemResult(item: BudgetItemRow): BudgetItemResult {
  return {
    id: item.id,
    budgetId: item.budgetId,
    categoryId: item.categoryId,
    amountCents: item.amount.toString(),
  };
}

export function createBudgetsService(
  dependencies: BudgetsServiceDependencies = {},
): BudgetsService {
  const repository = dependencies.repository ?? budgetsRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const mutate: Mutation =
    dependencies.withUserMutation ??
    ((userId, callback) => defaultMutation(cache)(userId, callback));

  return {
    async getSetupSuggestions(userId) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/budgets/suggestions",
          query: {},
          revision,
        },
        async () =>
          (await repository.getCategoryMedians(userId, 90)).map(
            (suggestion) => ({
              ...suggestion,
              medianCents: suggestion.medianCents.toString(),
            }),
          ),
      );
    },

    async getActiveBudget(userId) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/budgets/active",
          query: {},
          revision,
        },
        async () => {
          const budget = await repository.getActiveBudget(userId);
          if (!budget) throw new NotFoundError("active budget");
          const items = await repository.getBudgetItems(budget.id);
          const names = await repository.getCategoryNames(
            userId,
            items.map((item) => item.categoryId),
          );
          return toBudgetDto(
            budget,
            items.map((item) => ({
              ...item,
              categoryName: names.get(item.categoryId) ?? "Unknown",
            })),
          );
        },
      );
    },

    async createBudget(userId, input) {
      const budget = await mutate(userId, async (tx) => {
        await assertCategoriesOwned(repository, userId, input.items, tx);
        const row = await repository.createBudget(
          userId,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            items: input.items.map((item) => ({
              categoryId: item.categoryId,
              amountCents: BigInt(item.amountCents),
            })),
          },
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityType: "budget",
            entityId: row.id,
            action: "create",
            source: "budgets.create",
            after: row,
          },
          tx,
        );
        return row;
      });
      return { id: budget.id };
    },

    async getBudgetProgress(userId, budgetId) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/budgets/:id/progress",
          query: { id: [budgetId] },
          revision,
        },
        async () => {
          const budget = await repository.getActiveBudget(userId);
          if (!budget || budget.id !== budgetId)
            throw new NotFoundError("budget");
          const items = await repository.getBudgetItems(budget.id);
          if (items.length === 0) throw new NotFoundError("budget progress");
          const { start, end } = currentPeriodRange(
            budget.startDate,
            budget.period,
          );
          const spentRows = await repository.getSpentByCategory(
            userId,
            start,
            end,
          );
          const names = await repository.getCategoryNames(
            userId,
            items.map((item) => item.categoryId),
          );
          const progress = budgetProgress(
            items.map((item) => ({
              categoryId: item.categoryId,
              amountCents: item.amount,
            })),
            spentRows.map((row) => ({
              categoryId: row.categoryId,
              amountCents: row.spentCents,
            })),
          );
          return {
            periodStart: start,
            periodEnd: end,
            totalBudgetedCents: progress
              .reduce((total, item) => total + item.budgetedCents, 0n)
              .toString(),
            totalSpentCents: progress
              .reduce((total, item) => total + item.spentCents, 0n)
              .toString(),
            items: progress.map((item) => ({
              categoryId: item.categoryId,
              categoryName: names.get(item.categoryId) ?? "Unknown",
              budgetedCents: item.budgetedCents.toString(),
              spentCents: item.spentCents.toString(),
              remainingCents: item.remainingCents.toString(),
            })),
          };
        },
      );
    },

    async replaceBudgetItems(userId, budgetId, items) {
      await mutate(userId, async (tx) => {
        const budget = await repository.getActiveBudget(userId, tx);
        if (!budget || budget.id !== budgetId)
          throw new NotFoundError("budget");
        await assertCategoriesOwned(repository, userId, items, tx);
        await repository.replaceBudgetItems(budgetId, items, tx);
        await repository.recordAudit(
          {
            userId,
            entityType: "budget",
            entityId: budgetId,
            action: "update",
            source: "budgets.replaceItems",
            after: { budgetId, items },
          },
          tx,
        );
      });
    },

    async upsertBudgetItem(userId, categoryId, amountCents) {
      return itemResult(
        await mutate(userId, async (tx) => {
          await assertCategoriesOwned(repository, userId, [{ categoryId }], tx);
          let budget = await repository.getActiveBudget(userId, tx);
          if (!budget) {
            budget = await repository.createBudget(userId, { items: [] }, tx);
            await repository.recordAudit(
              {
                userId,
                entityType: "budget",
                entityId: budget.id,
                action: "create",
                source: "budgets.upsertItem",
                after: budget,
              },
              tx,
            );
          }
          const item = await repository.upsertBudgetItem(
            budget.id,
            categoryId,
            amountCents,
            tx,
          );
          await repository.recordAudit(
            {
              userId,
              entityType: "budget_item",
              entityId: item.id,
              action: "update",
              source: "budgets.upsertItem",
              after: item,
            },
            tx,
          );
          return item;
        }),
      );
    },

    async deleteBudgetItem(userId, categoryId) {
      const active = await repository.getActiveBudget(userId);
      if (!active) return false;
      return mutate(userId, async (tx) => {
        const budget = await repository.getActiveBudget(userId, tx);
        if (!budget) return false;
        if (!(await repository.categoryExists(userId, categoryId, tx))) {
          throw new NotFoundError("category");
        }
        const deleted = await repository.deleteBudgetItem(
          budget.id,
          categoryId,
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityType: "budget_item",
            entityId: categoryId,
            action: "delete",
            source: "budgets.deleteItem",
          },
          tx,
        );
        return deleted;
      });
    },
  };
}

export const createBudgetService = createBudgetsService;
