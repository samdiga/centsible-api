import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  getUserRevision,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { getDb, schema } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  NotFoundError,
  ValidationError,
} from "../../platform/errors/app-error.js";
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

const defaultDispatcher: RuleJobDispatcher = {
  async dispatchRetroactive(ruleId, userId) {
    const rows = await getDb()
      .insert(schema.jobs)
      .values({
        type: "rule_retroactive_apply",
        payload: { ruleId, userId },
        userId,
        status: "pending",
      })
      .returning({ id: schema.jobs.id });
    const row = rows[0];
    if (!row)
      throw new Error("Rule retroactive job insert did not return a row");
    return row;
  },
};

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
}>;

export type RuleServiceDependencies = Readonly<{
  repository?: RuleRepository;
  cache?: Pick<ResponseCache, "getOrCompute" | "invalidateUser">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
  dispatcher?: RuleJobDispatcher;
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
  const dispatcher = dependencies.dispatcher ?? defaultDispatcher;

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
      return repository.countMatchingTransactions(
        userId,
        query.matchType,
        query.matchMerchant ?? null,
      );
    },

    async createRule(userId, input) {
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
        // Dispatch is intentionally post-commit: Plan 3 owns the worker adapter.
        // A dispatcher failure is propagated rather than hidden behind a null ID.
        retroactiveJobId = (
          await dispatcher.dispatchRetroactive(row.id, userId)
        ).id;
      }
      return { rule: toRuleDto(row), retroactiveJobId };
    },

    async updateRule(userId, id, input) {
      const row = await mutate(userId, async (tx) => {
        const before = await repository.findRuleById(id, userId, tx);
        if (!before) throw new NotFoundError("rule");
        await assertReferences(repository, userId, input, tx);
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
        const before = await repository.findRuleById(id, userId, tx);
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
  };
}

export type { RuleRepository } from "./rules.repository.js";
export type { RuleMatchType };
