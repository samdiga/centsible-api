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
import { UpstreamError } from "../../platform/errors/app-error.js";
import {
  accountRepository,
  type AccountRepository,
} from "./accounts.repository.js";
import { toAccountAuditSnapshot } from "./accounts-audit.js";
import {
  noOpActiveItemUnlinker,
  type ActiveItemUnlinker,
} from "./accounts-item-unlinker.js";
import { toAccountSummary } from "./accounts.mapper.js";
import type { AccountBalance, AccountSummary } from "./accounts.schemas.js";

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
  listAccountSummaries: (userId: string) => Promise<AccountSummary[]>;
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
    async listAccountSummaries(userId) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        { userId, method: "GET", route: "/accounts", query: {}, revision },
        async () => {
          const rows = await repository.listByUser(userId);
          return rows.map(toAccountSummary);
        },
      );
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

      let decision: { itemId: string | null; unlink: boolean };
      try {
        decision = await mutate(userId, async (tx) => {
          let itemId = initial.plaidItemId;
          let current = await repository.findById(userId, accountId, tx);
          if (!current || current.deletedAt) throw new MutationSkipped();
          let itemRecord = itemId
            ? await repository.findOwnedItem(userId, itemId, tx)
            : null;
          let activeItem = itemRecord !== null && itemRecord.deletedAt === null;
          if (activeItem && itemId) {
            await repository.lockItem(userId, itemId, tx);
            current = await repository.findById(userId, accountId, tx);
            if (!current || current.deletedAt) throw new MutationSkipped();
          }
          // A concurrent relink can move the account between the optimistic
          // read and this transaction. Validate and lock the current item too,
          // then re-read so the zero-live decision uses one tenant-owned item.
          if (current.plaidItemId !== itemId) {
            itemId = current.plaidItemId;
            itemRecord = itemId
              ? await repository.findOwnedItem(userId, itemId, tx)
              : null;
            activeItem = itemRecord !== null && itemRecord.deletedAt === null;
            if (activeItem && itemId) {
              await repository.lockItem(userId, itemId, tx);
              current = await repository.findById(userId, accountId, tx);
              if (!current || current.deletedAt) throw new MutationSkipped();
            }
          }
          const deleted = await repository.softDelete(userId, accountId, tx);
          if (!deleted) throw new MutationSkipped();
          await repository.recordAudit?.(
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
