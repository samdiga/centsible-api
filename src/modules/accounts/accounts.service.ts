import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  getUserRevision,
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { redactLogValue } from "../../platform/logging/redaction.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import {
  NotFoundError,
  UnprocessableError,
  UpstreamError,
} from "../../platform/errors/app-error.js";
import { normalizeManualBalanceCents } from "../../shared/money/account-balance.js";
import {
  accountRepository,
  type AccountRepository,
  type AccountType,
  type LinkedAccountPatch,
  type ManualAccountPatch,
} from "./accounts.repository.js";
import { toAccountAuditSnapshot } from "./accounts-audit.js";
import {
  noOpActiveItemUnlinker,
  type ActiveItemUnlinker,
} from "./accounts-item-unlinker.js";
import { toAccountSummary } from "./accounts.mapper.js";
import type {
  AccountBalance,
  AccountSummary,
  CreateManualAccountInput,
  UpdateAccountInput,
} from "./accounts.schemas.js";

const MANUAL_SUBTYPE_TO_TYPE: Record<
  CreateManualAccountInput["subtype"],
  AccountType
> = {
  cash: "other",
  checking: "depository",
  savings: "depository",
  credit_card: "credit",
};

export type RemoveAccountResult = Readonly<{
  removed: boolean;
  unlinkedItem: boolean;
}>;

export type AccountRefresher = Readonly<{
  refreshAccountBalance: (input: {
    userId: string;
    accountId: string;
    tx: DbTransaction;
  }) => Promise<AccountBalance>;
}>;
export type AccountRefreshPort = AccountRefresher;

export type AccountLogger = Readonly<{
  error: (
    bindings: Record<string, unknown>,
    message: string,
  ) => void | PromiseLike<void>;
}>;

export type AccountService = Readonly<{
  listAccountSummaries: (
    userId: string,
    options?: { includeArchived?: boolean },
  ) => Promise<AccountSummary[]>;
  createManualAccount: (
    userId: string,
    input: CreateManualAccountInput,
  ) => Promise<AccountSummary>;
  updateAccount: (
    userId: string,
    accountId: string,
    input: UpdateAccountInput,
  ) => Promise<AccountSummary>;
  refreshAccountBalance: (
    userId: string,
    accountId: string,
  ) => Promise<AccountBalance>;
  removeAccount: (
    userId: string,
    accountId: string,
  ) => Promise<RemoveAccountResult>;
}>;

export type AccountServiceDependencies = Readonly<{
  repository?: AccountRepository;
  cache?: Pick<ResponseCache, "getOrCompute" | "invalidateUser">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
  refresher?: AccountRefresher;
  unlinkActiveItem?: ActiveItemUnlinker;
  logger?: AccountLogger;
}>;

const unavailableRefresher: AccountRefresher = {
  refreshAccountBalance: async () => {
    throw new UpstreamError();
  },
};
const defaultLogger: AccountLogger = {
  error: (bindings, message) => runtimeLogger.error(bindings, message),
};
class MutationSkipped extends Error {}

function defaultMutation(
  cache: Pick<ResponseCache, "invalidateUser">,
): UserMutationService["withUserMutation"] {
  return createWithUserMutation({ db: getDb(), cache });
}

export function createAccountService(
  dependencies: AccountServiceDependencies = {},
): AccountService {
  const repository = dependencies.repository ?? accountRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    ((userId, callback) => defaultMutation(cache)(userId, callback));
  const refresher = dependencies.refresher ?? unavailableRefresher;
  const unlinker = dependencies.unlinkActiveItem ?? noOpActiveItemUnlinker;
  const logger = dependencies.logger ?? defaultLogger;

  return {
    async listAccountSummaries(userId, options = {}) {
      const includeArchived = options.includeArchived === true;
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/accounts",
          query: includeArchived ? { includeArchived: ["true"] } : {},
          revision,
        },
        async () => {
          const rows = await repository.listByUser(userId);
          // Archived manual accounts leave the default list; their
          // transactions stay in transaction lists and reports.
          return rows
            .filter((row) => includeArchived || row.archivedAt === null)
            .map(toAccountSummary);
        },
      );
    },

    async createManualAccount(userId, input) {
      const type = MANUAL_SUBTYPE_TO_TYPE[input.subtype];
      const currentBalance = normalizeManualBalanceCents(
        input.subtype,
        input.openingBalanceCents,
      );
      const limit =
        input.subtype === "credit_card" ? (input.limitCents ?? null) : null;
      const created = await mutate(userId, async (tx) => {
        const row = await repository.insertManualAccount(
          userId,
          {
            name: input.name,
            type,
            subtype: input.subtype,
            currentBalance,
            limit,
          },
          tx,
        );
        await repository.recordAudit(
          {
            userId,
            entityId: row.id,
            action: "create",
            source: "accounts.create-manual",
            after: toAccountAuditSnapshot(row),
          },
          tx,
        );
        return row;
      });
      return toAccountSummary({ ...created, plaidItem: null });
    },

    async updateAccount(userId, accountId, input) {
      const updated = await mutate(userId, async (tx) => {
        const current = await repository.findByIdForUpdate(
          userId,
          accountId,
          tx,
        );
        if (!current || current.deletedAt) throw new NotFoundError("account");
        if (!current.isManual && input.archived !== undefined)
          throw new UnprocessableError(
            "Only manual accounts can be archived.",
          );
        if (input.limitCents !== undefined && current.subtype !== "credit_card")
          throw new UnprocessableError(
            "A credit limit applies only to credit card accounts.",
          );
        if (current.isManual && input.name === null)
          throw new UnprocessableError(
            "Manual accounts require a display name.",
          );

        const manualPatch: ManualAccountPatch = {
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(input.limitCents !== undefined
            ? { limit: input.limitCents }
            : {}),
          ...(input.paymentDueDate !== undefined
            ? { paymentDueDate: input.paymentDueDate }
            : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.archived !== undefined
            ? {
                archivedAt: input.archived
                  ? (current.archivedAt ?? new Date())
                  : null,
              }
            : {}),
        };
        const linkedPatch: LinkedAccountPatch = {
          ...(input.name !== undefined ? { nameOverride: input.name } : {}),
          ...(input.limitCents !== undefined
            ? { limitOverride: input.limitCents }
            : {}),
          ...(input.paymentDueDate !== undefined
            ? { paymentDueDateOverride: input.paymentDueDate }
            : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
        };
        const row = current.isManual
          ? await repository.updateManualAccount(
              userId,
              accountId,
              manualPatch,
              tx,
            )
          : await repository.updateLinkedAccount(
              userId,
              accountId,
              linkedPatch,
              tx,
            );
        if (!row) throw new NotFoundError("account");
        await repository.recordAudit(
          {
            userId,
            entityId: accountId,
            action: "update",
            source: current.isManual
              ? "accounts.update-manual"
              : "accounts.update-linked",
            before: toAccountAuditSnapshot(current),
            after: toAccountAuditSnapshot(row),
          },
          tx,
        );
        return row;
      });
      return toAccountSummary({ ...updated, plaidItem: null });
    },

    async refreshAccountBalance(userId, accountId) {
      // The pre-Plan-3 adapter is intentionally unavailable. Fail before
      // opening a database transaction; an unavailable upstream cannot mutate
      // anything and should remain a typed 502 response.
      if (refresher === unavailableRefresher) throw new UpstreamError();
      return mutate(userId, (tx) =>
        refresher.refreshAccountBalance({ userId, accountId, tx }),
      );
    },

    async removeAccount(userId, accountId) {
      const initial = await repository.findById(userId, accountId);
      if (!initial || initial.deletedAt)
        return { removed: false, unlinkedItem: false };
      // Deleting manual accounts is out of scope: nothing may cascade to
      // their transactions or balances. Archive them instead.
      if (initial.isManual)
        throw new UnprocessableError(
          "Manual accounts can't be deleted. Archive the account instead.",
        );

      let decision: { itemId: string | null; unlink: boolean };
      try {
        decision = await mutate(userId, async (tx) => {
          // The row lock is the decisive read. It serializes this delete with
          // every relink/upsert before we trust the membership pointer.
          const current = await repository.findByIdForUpdate(
            userId,
            accountId,
            tx,
          );
          if (!current || current.deletedAt) throw new MutationSkipped();
          const itemId = current.plaidItemId;
          const itemRecord = itemId
            ? await repository.findOwnedItem(userId, itemId, tx)
            : null;
          let activeItem = false;
          if (itemRecord !== null && itemId) {
            await repository.lockItem(userId, itemId, tx);
            const lockedItem = await repository.findOwnedItemForUpdate(
              userId,
              itemId,
              tx,
            );
            activeItem = lockedItem !== null && lockedItem.deletedAt === null;
          }
          const deleted = await repository.softDelete(userId, accountId, tx);
          if (!deleted) throw new MutationSkipped();
          await repository.recordAudit(
            {
              userId,
              entityId: accountId,
              action: "delete",
              source: "accounts.remove",
              before: toAccountAuditSnapshot(current),
              after: toAccountAuditSnapshot(deleted),
            },
            tx,
          );
          if (!itemId || !activeItem) return { itemId: null, unlink: false };
          const remaining = await repository.countLiveByItem(
            userId,
            itemId,
            tx,
          );
          return { itemId, unlink: remaining === 0 };
        });
      } catch (error) {
        if (error instanceof MutationSkipped)
          return { removed: false, unlinkedItem: false };
        throw error;
      }

      if (!decision.unlink || !decision.itemId)
        return { removed: true, unlinkedItem: false };
      try {
        const unlinked = await unlinker.unlinkActiveItem({
          userId,
          itemId: decision.itemId,
        });
        return { removed: true, unlinkedItem: unlinked };
      } catch (error) {
        try {
          await logger.error(
            { userId, itemId: decision.itemId, error: redactLogValue(error) },
            "Account item unlink failed after account removal",
          );
        } catch {
          // Logging is best effort after the local delete has committed.
        }
        return { removed: true, unlinkedItem: false };
      }
    },
  };
}
