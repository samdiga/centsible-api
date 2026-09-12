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
import {
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../platform/errors/app-error.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import { redactLogValue } from "../../platform/logging/redaction.js";
import { toRuleDto } from "./rules.mapper.js";
import { rulesRepository, type RuleRepository } from "./rules.repository.js";
import type {
  CreateRuleInput,
  RuleDto,
  RuleMatchType,
  RulePreviewQuery,
  UpdateRuleInput,
} from "./rules.schemas.js";

export type RuleJobDispatcher = Readonly<{
  dispatchRetroactive: (
    ruleId: string,
    userId: string,
  ) => Promise<{ id: string }>;
}>;

export type RuleLogger = Readonly<{
  error: (
    bindings: Record<string, unknown>,
    message: string,
  ) => void | PromiseLike<void>;
}>;

export type RuleCreateResult = Readonly<{
  rule: RuleDto;
  retroactiveJobId: string | null;
}>;

export type RuleService = Readonly<{
  listRules: (userId: string) => Promise<RuleDto[]>;
  previewCount: (userId: string, query: RulePreviewQuery) => Promise<number>;
  createRule: (
    userId: string,
    input: CreateRuleInput,
  ) => Promise<RuleCreateResult>;
  updateRule: (
    userId: string,
    id: string,
    input: UpdateRuleInput,
  ) => Promise<RuleDto>;
  deleteRule: (userId: string, id: string) => Promise<boolean>;
  applyRetroactively: (
    userId: string,
    id: string,
  ) => Promise<{ jobId: string }>;
}>;

export type RuleServiceDependencies = Readonly<{
  repository?: RuleRepository;
  cache?: Pick<ResponseCache, "getOrCompute" | "invalidateUser">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
  dispatcher?: RuleJobDispatcher;
  logger?: RuleLogger;
}>;

function autoName(
  matchMerchant: string | null | undefined,
  categoryName: string | null,
): string {
  return `${matchMerchant ?? "Any merchant"} → ${categoryName ?? "Unknown"}`;
}

function defaultMutation(cache: Pick<ResponseCache, "invalidateUser">) {
  return createWithUserMutation({ db: getDb(), cache });
}

async function assertReferences(
  repository: RuleRepository,
  userId: string,
  input: {
    actionCategoryId?: string | null | undefined;
    actionMemberId?: string | null | undefined;
    matchAccountId?: string | null | undefined;
    actionAddTagIds?: string[] | null | undefined;
  },
  tx: DbTransaction,
): Promise<void> {
  if (
    input.actionCategoryId !== undefined &&
    input.actionCategoryId !== null &&
    !(await repository.categoryExists(userId, input.actionCategoryId, tx))
  ) {
    throw new ValidationError(
      "categoryId does not exist or is not accessible to this user.",
    );
  }
  if (
    input.actionMemberId !== undefined &&
    input.actionMemberId !== null &&
    !(await repository.householdMemberExists(userId, input.actionMemberId, tx))
  ) {
    throw new ValidationError(
      "householdMemberId does not exist or is not accessible to this user.",
    );
  }
  if (
    input.matchAccountId !== undefined &&
    input.matchAccountId !== null &&
    !(await repository.accountExists(userId, input.matchAccountId, tx))
  ) {
    throw new ValidationError(
      "accountId does not exist or is not accessible to this user.",
    );
  }
  if (
    input.actionAddTagIds !== undefined &&
    input.actionAddTagIds !== null &&
    input.actionAddTagIds.length > 0 &&
    !(await repository.tagsExist(userId, input.actionAddTagIds, tx))
  ) {
    throw new ValidationError(
      "One or more tag ids do not exist or are not accessible to this user.",
    );
  }
}

export function createRuleService(
  dependencies: RuleServiceDependencies = {},
): RuleService {
  const repository = dependencies.repository ?? rulesRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const revision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const mutate =
    dependencies.withUserMutation ??
    ((userId, callback) => defaultMutation(cache)(userId, callback));
  const dispatcher = dependencies.dispatcher;
  const logger = dependencies.logger ?? {
    error: (bindings: Record<string, unknown>, message: string) =>
      runtimeLogger.error(bindings, message),
  };

  return {
    async listRules(userId) {
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/rules",
          query: {},
          revision: await revision(userId),
        },
        async () => (await repository.listRules(userId)).map(toRuleDto),
      );
    },

    async previewCount(userId, query) {
      return repository.countMatchingTransactions(userId, {
        matchType: query.matchType,
        matchMerchant: query.matchMerchant ?? null,
        matchNameContains: query.matchNameContains ?? null,
        matchAmountMin:
          query.matchAmountMin === undefined
            ? null
            : BigInt(query.matchAmountMin),
        matchAmountMax:
          query.matchAmountMax === undefined
            ? null
            : BigInt(query.matchAmountMax),
        matchAccountId: query.matchAccountId ?? null,
      });
    },

    async createRule(userId, input) {
      if (input.applyToExisting && !dispatcher) {
        throw new ServiceUnavailableError();
      }
      const row = await mutate(userId, async (tx) => {
        await assertReferences(repository, userId, input, tx);
        const categoryName = input.actionCategoryId
          ? await repository.categoryName(userId, input.actionCategoryId, tx)
          : null;
        return repository
          .createRule(
            userId,
            {
              matchType: input.matchType,
              matchMerchant: input.matchMerchant ?? null,
              matchNameContains: input.matchNameContains ?? null,
              matchAmountMin:
                input.matchAmountMin === undefined ||
                input.matchAmountMin === null
                  ? null
                  : BigInt(input.matchAmountMin),
              matchAmountMax:
                input.matchAmountMax === undefined ||
                input.matchAmountMax === null
                  ? null
                  : BigInt(input.matchAmountMax),
              matchAccountId: input.matchAccountId ?? null,
              actionCategoryId: input.actionCategoryId,
              actionMemberId: input.actionMemberId ?? null,
              actionSetNotes: input.actionSetNotes ?? null,
              actionMarkReviewed: input.actionMarkReviewed ?? null,
              actionExcludeFromBudgets: input.actionExcludeFromBudgets ?? null,
              actionRename: input.actionRename ?? null,
              actionHide: input.actionHide ?? null,
              actionAddTags: input.actionAddTagIds ?? null,
              name: input.name ?? autoName(input.matchMerchant, categoryName),
              priority: 100,
              applyToExisting: input.applyToExisting,
            },
            tx,
          )
          .then(async (created) => {
            await repository.recordAudit(
              {
                userId,
                entityId: created.id,
                action: "create",
                source: "rules.create",
                after: created,
              },
              tx,
            );
            return created;
          });
      });
      let retroactiveJobId: string | null = null;
      if (input.applyToExisting) {
        try {
          retroactiveJobId = (
            await dispatcher!.dispatchRetroactive(row.id, userId)
          ).id;
        } catch (error: unknown) {
          try {
            await logger.error(
              { userId, ruleId: row.id, error: redactLogValue(error) },
              "Rule retroactive job dispatch failed after rule creation",
            );
          } catch {
            // Logging must not turn a committed rule into a retryable failure.
          }
        }
      }
      return { rule: toRuleDto(row), retroactiveJobId };
    },

    async updateRule(userId, id, input) {
      const row = await mutate(userId, async (tx) => {
        const before = await repository.findRuleByIdForUpdate(id, userId, tx);
        if (!before) throw new NotFoundError("rule");
        await assertReferences(repository, userId, input, tx);
        const merged = {
          actionCategoryId:
            "actionCategoryId" in input
              ? input.actionCategoryId
              : before.actionCategoryId,
          actionMemberId:
            "actionMemberId" in input
              ? input.actionMemberId
              : before.actionMemberId,
          actionSetNotes:
            "actionSetNotes" in input
              ? input.actionSetNotes
              : before.actionSetNotes,
          actionMarkReviewed:
            "actionMarkReviewed" in input
              ? input.actionMarkReviewed
              : before.actionMarkReviewed,
          actionExcludeFromBudgets:
            "actionExcludeFromBudgets" in input
              ? input.actionExcludeFromBudgets
              : before.actionExcludeFromBudgets,
          actionRename:
            "actionRename" in input ? input.actionRename : before.actionRename,
          actionHide:
            "actionHide" in input ? input.actionHide : before.actionHide,
          actionAddTagIds:
            "actionAddTagIds" in input
              ? input.actionAddTagIds
              : before.actionAddTags,
        };
        const hasAction =
          !!merged.actionCategoryId ||
          !!merged.actionMemberId ||
          !!merged.actionSetNotes ||
          !!merged.actionMarkReviewed ||
          !!merged.actionExcludeFromBudgets ||
          !!merged.actionRename ||
          !!merged.actionHide ||
          !!(merged.actionAddTagIds && merged.actionAddTagIds.length > 0);
        if (!hasAction) {
          throw new ValidationError(
            "This update would leave the rule with no actions set.",
          );
        }
        const updated = await repository.updateRule(id, userId, input, tx);
        if (!updated) throw new NotFoundError("rule");
        await repository.recordAudit(
          {
            userId,
            entityId: id,
            action: "update",
            source: "rules.update",
            before,
            after: updated,
          },
          tx,
        );
        return updated;
      });
      return toRuleDto(row);
    },

    async deleteRule(userId, id) {
      await mutate(userId, async (tx) => {
        const before = await repository.findRuleByIdForUpdate(id, userId, tx);
        if (!before) throw new NotFoundError("rule");
        const deleted = await repository.deleteRule(id, userId, tx);
        if (!deleted) throw new NotFoundError("rule");
        await repository.recordAudit(
          {
            userId,
            entityId: id,
            action: "delete",
            source: "rules.delete",
            before,
            after: deleted,
          },
          tx,
        );
      });
      return true;
    },

    async applyRetroactively(userId, id) {
      const existing = await repository.findRuleById(id, userId);
      if (!existing) throw new NotFoundError("rule");
      if (!dispatcher) throw new ServiceUnavailableError();
      const { id: jobId } = await dispatcher.dispatchRetroactive(id, userId);
      return { jobId };
    },
  };
}

export type { RuleRepository } from "./rules.repository.js";
export type { RuleMatchType };
